/**
 * Remote-backed tool operations: read/write/edit over the RemoteFs router
 * (SFTP with automatic shell-exec fallback), bash over an exec channel.
 * All operations share one persistent RemoteConnection.
 */

import path from "node:path";
import type {
	BashOperations,
	EditOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { RemoteConnection } from "./connection.ts";
import type { RemoteFs } from "./remote-fs.ts";
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

const IMAGE_SIGNATURES: Array<{ mime: string; matches: (head: Buffer) => boolean }> = [
	{ mime: "image/jpeg", matches: (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
	{ mime: "image/png", matches: (head) => head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ mime: "image/gif", matches: (head) => head.length >= 4 && head.subarray(0, 4).toString("latin1") === "GIF8" },
	{ mime: "image/webp", matches: (head) => head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" },
];

export function createRemoteReadOps(fs: RemoteFs): ReadOperations {
	return {
		readFile: (filePath) => fs.readFile(toPosix(filePath)),
		access: async (filePath) => {
			await fs.stat(toPosix(filePath));
		},
		detectImageMimeType: async (filePath) => {
			try {
				const head = (await fs.readFile(toPosix(filePath))).subarray(0, 16);
				return IMAGE_SIGNATURES.find((signature) => signature.matches(head))?.mime ?? null;
			} catch {
				return null;
			}
		},
	};
}

export function createRemoteWriteOps(fs: RemoteFs): WriteOperations {
	return {
		mkdir: (dir) => fs.mkdirs(toPosix(dir)),
		writeFile: (filePath, content) => fs.writeFile(toPosix(filePath), Buffer.from(content, "utf8")),
	};
}

export function createRemoteEditOps(fs: RemoteFs): EditOperations {
	const readOps = createRemoteReadOps(fs);
	const writeOps = createRemoteWriteOps(fs);
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
