/**
 * Remote-backed tool operations: read/write/edit over SFTP, bash over an
 * exec channel. All operations share one persistent RemoteConnection.
 */

import path from "node:path";
import type { SFTPWrapper } from "ssh2";
import type {
	BashOperations,
	EditOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { RemoteConnection } from "./connection.ts";
import { FriendlySshError, classifyConnectionError, isFriendly } from "./errors.ts";
import { CONFIG_PATH } from "./config.ts";

function toPosix(filePath: string): string {
	// pi resolves relative tool paths against the remote cwd with the local
	// path module. On Windows that introduces backslashes AND a drive-letter
	// prefix (path.win32.resolve("/home/x") === "C:\\home\\x"). Remote paths
	// are always POSIX, so normalize both away.
	const slashes = filePath.replaceAll("\\", "/");
	return /^[A-Za-z]:\//.test(slashes) ? slashes.slice(2) : slashes;
}

function sftpReadFile(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		sftp.readFile(remotePath, (error, data) => (error ? reject(error) : resolve(data)));
	});
}

function sftpWriteFile(sftp: SFTPWrapper, remotePath: string, content: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.writeFile(remotePath, content, (error) => (error ? reject(error) : resolve()));
	});
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<{ isDirectory: () => boolean }> {
	return new Promise((resolve, reject) => {
		sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)));
	});
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.mkdir(remotePath, (error) => (error ? reject(error) : resolve()));
	});
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
	});
}

function sftpPosixRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.ext_openssh_rename(from, to, (error) => (error ? reject(error) : resolve()));
	});
}

function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.unlink(remotePath, (error) => (error ? reject(error) : resolve()));
	});
}

function sftpSetMode(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.setstat(remotePath, { mode }, (error) => (error ? reject(error) : resolve()));
	});
}

/**
 * Atomic-ish write: upload to a temp file next to the target, preserve the
 * target's mode, then rename over it. A dropped connection mid-upload can
 * never leave the real file truncated. Falls back to a direct write only if
 * the server cannot rename at all.
 */
async function atomicWrite(sftp: SFTPWrapper, remotePath: string, content: Buffer): Promise<void> {
	const tempPath = `${path.posix.dirname(remotePath)}/.${path.posix.basename(remotePath)}.pi-tmp-${Math.random().toString(36).slice(2, 10)}`;
	const existing = await sftpStat(sftp, remotePath).catch(() => null);
	try {
		await sftpWriteFile(sftp, tempPath, content);
		if (existing && "mode" in existing && typeof (existing as { mode?: number }).mode === "number") {
			await sftpSetMode(sftp, tempPath, (existing as { mode: number }).mode & 0o7777).catch(() => {});
		}
		try {
			await sftpPosixRename(sftp, tempPath, remotePath);
		} catch {
			try {
				await sftpRename(sftp, tempPath, remotePath);
			} catch {
				// SFTP v3 RENAME refuses to overwrite. Unlink then rename; the
				// window without the file is tiny and the content is safe either way.
				if (existing) await sftpUnlink(sftp, remotePath).catch(() => {});
				await sftpRename(sftp, tempPath, remotePath);
			}
		}
	} catch (error) {
		await sftpUnlink(sftp, tempPath).catch(() => {});
		throw error;
	}
}

async function mkdirRecursive(sftp: SFTPWrapper, dir: string): Promise<void> {
	const normalized = path.posix.normalize(toPosix(dir));
	const segments = normalized.split("/").filter(Boolean);
	let current = normalized.startsWith("/") ? "/" : "";
	for (const segment of segments) {
		current = current === "" ? segment : path.posix.join(current, segment);
		try {
			const stats = await sftpStat(sftp, current);
			if (stats.isDirectory()) continue;
			throw new Error(`ENOTDIR: '${current}' exists and is not a directory`);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("ENOTDIR")) throw error;
			// Missing: try to create it. Races with concurrent creation are fine.
			try {
				await sftpMkdir(sftp, current);
			} catch (mkdirError) {
				const stats = await sftpStat(sftp, current).catch(() => null);
				if (!stats?.isDirectory()) throw mkdirError;
			}
		}
	}
}

const IMAGE_SIGNATURES: Array<{ mime: string; matches: (head: Buffer) => boolean }> = [
	{ mime: "image/jpeg", matches: (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
	{ mime: "image/png", matches: (head) => head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ mime: "image/gif", matches: (head) => head.length >= 4 && head.subarray(0, 4).toString("latin1") === "GIF8" },
	{ mime: "image/webp", matches: (head) => head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" },
];

export function createRemoteReadOps(remote: RemoteConnection): ReadOperations {
	return {
		readFile: (filePath) => {
			const remotePath = toPosix(filePath);
			return remote.withSftp("open", remotePath, (sftp) => sftpReadFile(sftp, remotePath));
		},
		access: async (filePath) => {
			const remotePath = toPosix(filePath);
			await remote.withSftp("access", remotePath, (sftp) => sftpStat(sftp, remotePath));
		},
		detectImageMimeType: async (filePath) => {
			const remotePath = toPosix(filePath);
			try {
				const head = await remote.withSftp("read", remotePath, async (sftp) => {
					const buffer = await sftpReadFile(sftp, remotePath);
					return buffer.subarray(0, 16);
				});
				return IMAGE_SIGNATURES.find((signature) => signature.matches(head))?.mime ?? null;
			} catch {
				return null;
			}
		},
	};
}

export function createRemoteWriteOps(remote: RemoteConnection): WriteOperations {
	return {
		mkdir: async (dir) => {
			const remoteDir = toPosix(dir);
			await remote.withSftp("mkdir", remoteDir, (sftp) => mkdirRecursive(sftp, remoteDir));
		},
		writeFile: async (filePath, content) => {
			const remotePath = toPosix(filePath);
			await remote.withSftp("write", remotePath, (sftp) => atomicWrite(sftp, remotePath, Buffer.from(content, "utf8")));
		},
	};
}

export function createRemoteEditOps(remote: RemoteConnection): EditOperations {
	const readOps = createRemoteReadOps(remote);
	const writeOps = createRemoteWriteOps(remote);
	return {
		readFile: readOps.readFile,
		access: readOps.access,
		writeFile: writeOps.writeFile,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Remote bash execution. The remote command runs under `bash -c` in the
 * project directory (or the cwd pi asks for). Output streams live. The exit
 * code is the real remote exit code; transport failures are reported as a
 * clear message with exit code 255 and never silently rerun a command that
 * already produced output.
 */
export function createRemoteBashOps(remote: RemoteConnection, localCwd: string): BashOperations {
	return {
		// Note: the optional `env` from pi is intentionally not forwarded; the
		// remote shell uses the remote environment, like a native session would.
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const effectiveCwd = !cwd || path.resolve(cwd) === path.resolve(localCwd) ? remote.remoteCwd : toPosix(cwd);
			const script = `cd ${shellQuote(effectiveCwd)} && { ${command}\n}`;
			const remoteCommand = `bash -c ${shellQuote(script)}`;

			// pi's bash tool recognizes these exact error messages for
			// cancellation and timeout reporting; match the local contract.
			if (signal?.aborted) throw new Error("aborted");

			let channel;
			try {
				channel = await remote.execChannel(remoteCommand);
			} catch (error) {
				const friendly = isFriendly(error) ? error : classifyConnectionError(error, remote.target, CONFIG_PATH);
				onData(Buffer.from(`\n${friendly.message}\n`));
				return { exitCode: 255 };
			}

			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let exitCode: number | null = null;
				let sawExit = false;
				let finished = false;
				let timedOut = false;
				let aborted = false;
				let graceTimer: NodeJS.Timeout | undefined;

				const finish = (code: number | null) => {
					if (finished) return;
					finished = true;
					cleanup();
					if (aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				};

				// If the channel does not close promptly after we asked it to (for
				// example the network black-holed), force completion and drop the
				// connection so the next operation reconnects cleanly.
				const closeWithGrace = () => {
					channel.close();
					graceTimer ??= setTimeout(() => {
						remote.invalidateCurrent();
						finish(null);
					}, 5_000);
				};

				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							onData(Buffer.from(`\nCommand timed out after ${timeout}s; the remote process may still be running.\n`));
							closeWithGrace();
						}, timeout * 1000)
					: undefined;

				const onAbort = () => {
					aborted = true;
					closeWithGrace();
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				const cleanup = () => {
					if (timer) clearTimeout(timer);
					if (graceTimer) clearTimeout(graceTimer);
					signal?.removeEventListener("abort", onAbort);
				};

				channel.on("data", (data: Buffer) => onData(data));
				channel.stderr.on("data", (data: Buffer) => onData(data));
				channel.on("exit", (code: number | null) => {
					sawExit = true;
					exitCode = code;
				});
				channel.on("close", (closeCode?: number | null) => {
					// ssh2 may deliver the exit status either via the 'exit' event or
					// as the first argument of 'close', depending on packet ordering.
					if (!sawExit && typeof closeCode === "number") {
						sawExit = true;
						exitCode = closeCode;
					}
					if (timedOut || aborted) {
						finish(null);
						return;
					}
					if (!sawExit) {
						// Channel closed without an exit status: the connection dropped
						// mid-command. Be explicit instead of pretending it succeeded.
						onData(
							Buffer.from(
								`\n${new FriendlySshError(`SSH connection to ${remote.target} dropped while the command was running. The command may or may not have completed; verify before re-running commands with side effects.`, "connection", true).message}\n`,
							),
						);
						finish(255);
						return;
					}
					finish(exitCode);
				});
				channel.on("error", () => {
					onData(Buffer.from(`\nSSH channel error while running the command on ${remote.target}.\n`));
					finish(255);
				});
			});
		},
	};
}
