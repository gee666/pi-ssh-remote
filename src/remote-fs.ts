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
	/** List entry names in a directory (relative paths resolve against home). */
	listDir(remotePath: string): Promise<string[]>;
	/** Cheap session health check; throws if the backend cannot run at all. */
	probe(): Promise<void>;
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
		listDir: (remotePath) =>
			remote.withSftp("readdir", remotePath, (sftp) => {
				return new Promise<string[]>((resolve, reject) => {
					sftp.readdir(remotePath, (error, entries) => (error ? reject(error) : resolve(entries.map((entry) => entry.filename))));
				});
			}),
		probe: async () => {
			await remote.withSftp("probe", ".", (sftp) => sftpStat(sftp, "."));
		},
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
			// Anchor at $HOME first: some jailed shells do not start exec
			// commands in the home directory. The markers protect against any
			// banner/notice output the shell may inject.
			const script = `cd "$HOME" 2>/dev/null; cd -- ${shellQuote(remotePath)} 2>/dev/null || exit ${SHELL_ENOENT}; printf '<<PI[%s]PI>>' "$(pwd -P)"`;
			const result = await runScript(remote, script);
			if (result.code !== 0) throw shellError(result.code, "resolve", remotePath, result.stderr.toString());
			const match = result.stdout.toString().match(/<<PI\[([\s\S]*)\]PI>>/);
			if (!match) throw new Error(`Unexpected output while resolving '${remotePath}' on the remote: ${result.stdout.toString().slice(0, 200)}`);
			return match[1];
		},
		probe: async () => {
			const result = await runScript(remote, `echo __pi_probe_ok__`);
			if (result.code !== 0 || !result.stdout.toString().includes("__pi_probe_ok__")) {
				throw new Error(`Shell session probe failed (exit code ${result.code})${result.stderr.toString().trim() ? `: ${result.stderr.toString().trim()}` : ""}`);
			}
		},
		listDir: async (remotePath) => {
			const script = `cd "$HOME" 2>/dev/null; cd -- ${shellQuote(remotePath)} 2>/dev/null || exit ${SHELL_ENOENT}; printf '<<PI[';\nls -1A;\nprintf ']PI>>'`;
			const result = await runScript(remote, script);
			if (result.code !== 0) throw shellError(result.code, "readdir", remotePath, result.stderr.toString());
			const match = result.stdout.toString().match(/<<PI\[([\s\S]*)\]PI>>/);
			if (!match) return [];
			return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
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
	listDir(remotePath: string): Promise<string[]> {
		return this.run((fs) => fs.listDir(remotePath));
	}
	probe(): Promise<void> {
		return this.run((fs) => fs.probe());
	}

	/**
	 * Connect, resolve the configured project path (relative paths resolve
	 * against the remote home directory), and verify it is a directory.
	 * Updates `remote.remoteCwd` on success.
	 */
	async resolveProjectCwd(): Promise<string> {
		this.remote.pathProblem = null;
		const configured = this.remote.projectRef.project.path;
		let resolved: string;
		try {
			resolved = await this.realpathDir(configured);
			const stats = await this.stat(resolved);
			if (!stats.isDirectory) throw await this.pathError(configured);
		} catch (error) {
			if (isFriendly(error)) throw error;
			// A confirmed missing path maps to a path error; anything else means
			// the session/commands themselves failed, which must not be reported
			// as a wrong project path.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw await this.pathError(configured);
			throw await this.diagnoseFailure(error);
		}
		this.remote.remoteCwd = resolved;
		return resolved;
	}

	/**
	 * Distinguish "commands fail because the server refuses all sessions"
	 * (broken/disabled jailed shell: login succeeds, every session exits
	 * immediately, typically with code 254) from other unexpected errors.
	 */
	private async diagnoseFailure(original: unknown): Promise<FriendlySshError> {
		const message = original instanceof Error ? original.message : String(original);
		try {
			await this.probe();
		} catch {
			return new FriendlySshError(
				`SSH login to ${this.remote.target} succeeds, but the server refuses to start any session: SFTP and shell commands are both rejected immediately. ` +
					`This is a server-side restriction, not a configuration problem on this machine — shell access is disabled or the jailed shell is broken for this account ` +
					`(an immediate exit code 254 is typical for cPanel jailshell). Enable shell/SSH access in the hosting control panel or ask the hosting provider to fix it. ` +
					`(Underlying error: ${message})`,
				"no-session",
				false,
			);
		}
		return new FriendlySshError(`Failed to resolve the remote project path: ${message}`, "unknown", false);
	}

	/**
	 * Build a remote-path error enriched with what actually exists in the
	 * directory the configured path was resolved against, so a typo can be
	 * corrected without a separate shell session.
	 */
	private async pathError(configured: string): Promise<FriendlySshError> {
		const base = configured.startsWith("/") ? path.posix.dirname(configured) : ".";
		let hint = "";
		try {
			const entries = (await this.listDir(base)).filter((name) => name !== "." && name !== "..");
			const shown = entries.slice(0, 40).join(", ");
			const more = entries.length > 40 ? `, ... (${entries.length - 40} more)` : "";
			hint = `\nEntries that do exist in ${base === "." ? "the remote home directory" : `'${base}'`}: ${shown}${more}`;
		} catch {
			// Listing is best-effort diagnostics only.
		}
		return new FriendlySshError(
			`The configured remote project path '${configured}' does not exist on ${this.remote.target} or is not a directory. Update the project path in ${CONFIG_PATH}.${hint}`,
			"remote-path",
			false,
		);
	}
}
