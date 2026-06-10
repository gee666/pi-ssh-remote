/**
 * Remote filesystem abstraction with two backends:
 *
 * 1. SFTP (preferred): binary-safe, structured errors.
 * 2. Shell exec fallback: used automatically when the server refuses the
 *    SFTP subsystem (common on jailed/shared hosting, e.g. exit code 254
 *    while establishing the SFTP session). Uses only `cat`, `mv`, `mkdir`,
 *    `dirname`, `pwd` over exec channels; stdin/stdout are 8-bit clean, so
 *    this is binary-safe too. Writes stay atomic (temp file + mv).
 *
 * The router picks a backend on first use and switches to the shell
 * backend permanently if SFTP turns out to be unavailable.
 */

import path from "node:path";
import type { SFTPWrapper } from "ssh2";
import { CONFIG_PATH } from "./config.ts";
import type { RemoteConnection } from "./connection.ts";
import { FriendlySshError, isFriendly } from "./errors.ts";

export interface RemoteFs {
	readFile(remotePath: string): Promise<Buffer>;
	/** Atomic write (temp file + rename), preserving the target's mode. */
	writeFile(remotePath: string, content: Buffer): Promise<void>;
	stat(remotePath: string): Promise<{ isDirectory: boolean }>;
	mkdirs(remoteDir: string): Promise<void>;
	/** Resolve a (possibly relative) directory path to an absolute one. */
	realpathDir(remotePath: string): Promise<string>;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tempPathFor(remotePath: string): string {
	return `${path.posix.dirname(remotePath)}/.${path.posix.basename(remotePath)}.pi-tmp-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// SFTP backend
// ---------------------------------------------------------------------------

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

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<{ isDirectory: () => boolean; mode?: number }> {
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

async function sftpMkdirRecursive(sftp: SFTPWrapper, dir: string): Promise<void> {
	const normalized = path.posix.normalize(dir);
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
			try {
				await sftpMkdir(sftp, current);
			} catch (mkdirError) {
				const stats = await sftpStat(sftp, current).catch(() => null);
				if (!stats?.isDirectory()) throw mkdirError;
			}
		}
	}
}

async function sftpAtomicWrite(sftp: SFTPWrapper, remotePath: string, content: Buffer): Promise<void> {
	const tempPath = tempPathFor(remotePath);
	const existing = await sftpStat(sftp, remotePath).catch(() => null);
	try {
		await sftpWriteFile(sftp, tempPath, content);
		if (existing && typeof existing.mode === "number") {
			await sftpSetMode(sftp, tempPath, existing.mode & 0o7777).catch(() => {});
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

function createSftpFs(remote: RemoteConnection): RemoteFs {
	return {
		readFile: (remotePath) => remote.withSftp("open", remotePath, (sftp) => sftpReadFile(sftp, remotePath)),
		writeFile: (remotePath, content) => remote.withSftp("write", remotePath, (sftp) => sftpAtomicWrite(sftp, remotePath, content)),
		stat: (remotePath) =>
			remote.withSftp("access", remotePath, async (sftp) => {
				const stats = await sftpStat(sftp, remotePath);
				return { isDirectory: stats.isDirectory() };
			}),
		mkdirs: (remoteDir) => remote.withSftp("mkdir", remoteDir, (sftp) => sftpMkdirRecursive(sftp, remoteDir)),
		realpathDir: (remotePath) =>
			remote.withSftp("resolve", remotePath, (sftp) => {
				return new Promise<string>((resolve, reject) => {
					sftp.realpath(remotePath, (error, resolved) => (error ? reject(error) : resolve(resolved)));
				});
			}),
	};
}

// ---------------------------------------------------------------------------
// Shell exec backend
// ---------------------------------------------------------------------------

/** Exit codes used by the generated scripts to signal structured errors. */
const SHELL_ENOENT = 60;
const SHELL_EACCES = 61;
const SHELL_ENOTDIR = 62;

function shellError(code: number, operation: string, remotePath: string, stderr: string): Error {
	if (code === SHELL_ENOENT) {
		const error = new Error(`ENOENT: no such file or directory, ${operation} '${remotePath}'`) as Error & { code: string };
		error.code = "ENOENT";
		return error;
	}
	if (code === SHELL_EACCES) {
		const error = new Error(`EACCES: permission denied, ${operation} '${remotePath}'`) as Error & { code: string };
		error.code = "EACCES";
		return error;
	}
	if (code === SHELL_ENOTDIR) return new Error(`EISDIR/ENOTDIR: '${remotePath}' is not a regular file`);
	return new Error(`Remote ${operation} failed for '${remotePath}'${stderr.trim() ? `: ${stderr.trim()}` : ` (exit code ${code})`}`);
}

async function runScript(
	remote: RemoteConnection,
	script: string,
	input?: Buffer,
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
	for (let attempt = 0; ; attempt++) {
		const channel = await remote.execChannel(`bash -c ${shellQuote(script)}`);
		try {
			return await new Promise((resolve, reject) => {
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let exitCode: number | null = null;
				let sawExit = false;
				channel.on("data", (data: Buffer) => stdout.push(data));
				channel.stderr.on("data", (data: Buffer) => stderr.push(data));
				channel.on("exit", (code: number | null) => {
					sawExit = true;
					exitCode = code;
				});
				channel.on("close", (closeCode?: number | null) => {
					if (!sawExit && typeof closeCode === "number") {
						sawExit = true;
						exitCode = closeCode;
					}
					if (!sawExit) {
						reject(new FriendlySshError(`SSH connection to ${remote.target} dropped during a remote file operation.`, "connection", true));
						return;
					}
					resolve({ code: exitCode ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
				});
				channel.on("error", () => {
					reject(new FriendlySshError(`SSH channel error during a remote file operation on ${remote.target}.`, "connection", true));
				});
				if (input !== undefined) channel.end(input);
				else channel.end();
			});
		} catch (error) {
			// These scripts are idempotent (writes are temp-file + mv), so a
			// single transparent retry after a transport drop is safe.
			if (isFriendly(error) && error.retryable && attempt === 0) {
				remote.invalidateCurrent();
				continue;
			}
			throw error;
		}
	}
}

function createShellFs(remote: RemoteConnection): RemoteFs {
	return {
		readFile: async (remotePath) => {
			const q = shellQuote(remotePath);
			const result = await runScript(
				remote,
				`p=${q}; [ -e "$p" ] || exit ${SHELL_ENOENT}; [ -d "$p" ] && exit ${SHELL_ENOTDIR}; [ -r "$p" ] || exit ${SHELL_EACCES}; exec cat -- "$p"`,
			);
			if (result.code !== 0) throw shellError(result.code, "open", remotePath, result.stderr.toString());
			return result.stdout;
		},
		writeFile: async (remotePath, content) => {
			const q = shellQuote(remotePath);
			const t = shellQuote(tempPathFor(remotePath));
			const script = [
				`p=${q}; t=${t}`,
				`d=$(dirname -- "$p") || exit 1`,
				`[ -d "$d" ] || exit ${SHELL_ENOENT}`,
				`cat > "$t" || { rm -f -- "$t"; exit ${SHELL_EACCES}; }`,
				`if [ -e "$p" ]; then m=$(stat -c %a -- "$p" 2>/dev/null || stat -f %Lp -- "$p" 2>/dev/null); [ -n "$m" ] && chmod -- "$m" "$t" 2>/dev/null; fi`,
				`mv -f -- "$t" "$p" || { rm -f -- "$t"; exit ${SHELL_EACCES}; }`,
			].join("\n");
			const result = await runScript(remote, script, content);
			if (result.code !== 0) throw shellError(result.code, "write", remotePath, result.stderr.toString());
		},
		stat: async (remotePath) => {
			const q = shellQuote(remotePath);
			const result = await runScript(remote, `p=${q}; if [ -d "$p" ]; then echo d; elif [ -e "$p" ]; then echo f; else exit ${SHELL_ENOENT}; fi`);
			if (result.code !== 0) throw shellError(result.code, "access", remotePath, result.stderr.toString());
			return { isDirectory: result.stdout.toString().trim() === "d" };
		},
		mkdirs: async (remoteDir) => {
			const result = await runScript(remote, `mkdir -p -- ${shellQuote(remoteDir)}`);
			if (result.code !== 0) throw shellError(SHELL_EACCES, "mkdir", remoteDir, result.stderr.toString());
		},
		realpathDir: async (remotePath) => {
			const result = await runScript(remote, `cd -- ${shellQuote(remotePath)} 2>/dev/null || exit ${SHELL_ENOENT}; pwd -P`);
			if (result.code !== 0) throw shellError(result.code, "resolve", remotePath, result.stderr.toString());
			return result.stdout.toString().trim();
		},
	};
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class RemoteFsRouter implements RemoteFs {
	private readonly remote: RemoteConnection;
	private backend: RemoteFs | null = null;
	private usingShellFallback = false;
	/** Called once when falling back from SFTP to shell file operations. */
	onFallback?: (reason: string) => void;

	constructor(remote: RemoteConnection) {
		this.remote = remote;
	}

	private async pick(): Promise<RemoteFs> {
		if (this.backend) return this.backend;
		if (this.usingShellFallback) {
			this.backend = createShellFs(this.remote);
			return this.backend;
		}
		try {
			await this.remote.getSftp();
			this.backend = createSftpFs(this.remote);
		} catch (error) {
			if (isFriendly(error) && error.kind === "sftp-unavailable") {
				this.switchToShell(error.message);
			} else {
				throw error;
			}
		}
		return this.backend!;
	}

	private switchToShell(reason: string): void {
		this.usingShellFallback = true;
		this.backend = createShellFs(this.remote);
		this.onFallback?.(reason);
		this.onFallback = undefined;
	}

	private async run<T>(fn: (fs: RemoteFs) => Promise<T>): Promise<T> {
		const fs = await this.pick();
		try {
			return await fn(fs);
		} catch (error) {
			// SFTP died mid-session while exec channels still work: switch over
			// and retry the operation once on the shell backend.
			if (!this.usingShellFallback && isFriendly(error) && error.kind === "sftp-unavailable") {
				this.switchToShell(error.message);
				return await fn(this.backend!);
			}
			throw error;
		}
	}

	readFile(remotePath: string): Promise<Buffer> {
		return this.run((fs) => fs.readFile(remotePath));
	}
	writeFile(remotePath: string, content: Buffer): Promise<void> {
		return this.run((fs) => fs.writeFile(remotePath, content));
	}
	stat(remotePath: string): Promise<{ isDirectory: boolean }> {
		return this.run((fs) => fs.stat(remotePath));
	}
	mkdirs(remoteDir: string): Promise<void> {
		return this.run((fs) => fs.mkdirs(remoteDir));
	}
	realpathDir(remotePath: string): Promise<string> {
		return this.run((fs) => fs.realpathDir(remotePath));
	}

	/**
	 * Connect, resolve the configured project path (relative paths resolve
	 * against the remote home directory), and verify it is a directory.
	 * Updates `remote.remoteCwd` on success.
	 */
	async resolveProjectCwd(): Promise<string> {
		this.remote.pathProblem = null;
		const configured = this.remote.projectRef.project.path;
		const pathError = () =>
			new FriendlySshError(
				`The configured remote project path '${configured}' does not exist on ${this.remote.target} or is not a directory. Update the project path in ${CONFIG_PATH}.`,
				"remote-path",
				false,
			);
		let resolved: string;
		try {
			resolved = await this.realpathDir(configured);
			const stats = await this.stat(resolved);
			if (!stats.isDirectory) throw pathError();
		} catch (error) {
			if (isFriendly(error) && error.retryable) throw error;
			if (isFriendly(error) && error.kind !== "remote-path") throw error;
			throw pathError();
		}
		this.remote.remoteCwd = resolved;
		return resolved;
	}
}
