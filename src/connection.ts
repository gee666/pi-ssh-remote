/**
 * Persistent SSH connection management built on the pure-JS `ssh2` library.
 *
 * Operations lazily reconnect through a shared connection attempt. Only
 * read-only SFTP operations can be replayed after a transport failure.
 *
 * No external binaries (ssh, sshpass) and nothing installed on the remote:
 * file operations use the SFTP subsystem, bash uses exec channels.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import { CONFIG_PATH, KNOWN_HOSTS_PATH, expandHome, serverHost, type RemoteProject } from "./config.ts";
import { FriendlySshError, classifyConnectionError, classifySftpError, isFriendly } from "./errors.ts";
import { ConnectionSession } from "./connection-session.ts";

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;
const RECONNECT_BACKOFF_MS = [500, 1_500, 4_000];

type KnownHosts = Record<string, string>;

function loadKnownHosts(): KnownHosts {
	try {
		return JSON.parse(readFileSync(KNOWN_HOSTS_PATH, "utf8")) as KnownHosts;
	} catch {
		return {};
	}
}

function saveKnownHost(key: string, fingerprint: string): void {
	try {
		const hosts = loadKnownHosts();
		hosts[key] = fingerprint;
		if (!existsSync(path.dirname(KNOWN_HOSTS_PATH))) mkdirSync(path.dirname(KNOWN_HOSTS_PATH), { recursive: true });
		writeFileSync(KNOWN_HOSTS_PATH, `${JSON.stringify(hosts, null, "\t")}\n`);
	} catch {
		// Best effort; trust-on-first-use storage failing should not block work.
	}
}

function defaultAgent(): string | undefined {
	if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
	if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
	return undefined;
}

export class RemoteConnection {
	private session: ConnectionSession | null = null;
	private connecting: Promise<ConnectionSession> | null = null;
	private handshaking: ConnectionSession | null = null;
	private cancelBackoff: (() => void) | null = null;
	/** Set when the configured project path turned out to be invalid; fails all operations closed. */
	pathProblem: FriendlySshError | null = null;
	private disposed = false;
	private hostKeyMismatch: string | null = null;

	readonly projectRef: RemoteProject;
	readonly target: string;
	/** Resolved absolute remote project directory (set after first connect). */
	remoteCwd: string;
	/** Last connection problem, for status display. */
	lastFailure: string | null = null;
	onStateChange?: (state: "connected" | "reconnecting" | "failed") => void;

	get isConnected(): boolean {
		return this.session !== null && this.session.active && !this.disposed;
	}

	constructor(projectRef: RemoteProject) {
		this.projectRef = projectRef;
		const host = serverHost(projectRef.serverName, projectRef.server);
		const user = projectRef.server.user ?? projectRef.server.User;
		this.target = user ? `${user}@${host}` : host;
		this.remoteCwd = projectRef.project.path;
	}

	private async buildConnectConfig(): Promise<ConnectConfig> {
		const server = this.projectRef.server;
		const host = serverHost(this.projectRef.serverName, server);
		const port = Number(server.port ?? server.Port ?? 22);
		const username = server.user ?? server.User;

		const config: ConnectConfig = {
			host,
			port,
			username,
			readyTimeout: READY_TIMEOUT_MS,
			keepaliveInterval: KEEPALIVE_INTERVAL_MS,
			keepaliveCountMax: KEEPALIVE_COUNT_MAX,
			hostVerifier: (key: Buffer): boolean => {
				const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
				const knownKey = `${host}:${port}`;
				const stored = loadKnownHosts()[knownKey];
				if (!stored) {
					saveKnownHost(knownKey, fingerprint);
					return true;
				}
				if (stored === fingerprint) return true;
				this.hostKeyMismatch =
					`Host key for ${knownKey} changed (stored ${stored}, got ${fingerprint}). ` +
					`This can indicate a server reinstall or a man-in-the-middle attack. ` +
					`If the change is expected, remove the '${knownKey}' entry from ${KNOWN_HOSTS_PATH} and retry.`;
				return false;
			},
		};

		const identityFile = server.identityFile ?? server.IdentityFile;
		const passwordEnv = server.passwordEnv ?? server.PasswordEnv;
		const password = passwordEnv ? process.env[passwordEnv] : (server.password ?? server.Password);
		if (passwordEnv && password === undefined) {
			throw new FriendlySshError(
				`SSH password environment variable '${passwordEnv}' is not set. Export it or remove passwordEnv in ${CONFIG_PATH}.`,
				"config",
				false,
			);
		}

		if (identityFile) {
			const keyPath = expandHome(identityFile);
			try {
				config.privateKey = await readFile(keyPath);
			} catch {
				throw new FriendlySshError(
					`SSH identity file is not readable: ${keyPath}. Check the path and permissions in ${CONFIG_PATH}.`,
					"missing-key",
					false,
				);
			}
			const passphrase = server.passphraseEnv ? process.env[server.passphraseEnv] : server.passphrase;
			if (passphrase !== undefined) config.passphrase = passphrase;
		}
		if (password !== undefined) config.password = password;
		if (!identityFile && password === undefined) {
			const agent = defaultAgent();
			if (agent) config.agent = agent;
		}
		return config;
	}

	/** Lazily connect; concurrent callers share one in-flight attempt. */
	private async ensureConnected(): Promise<ConnectionSession> {
		if (this.disposed) throw new FriendlySshError("SSH remote connection has been closed.", "connection", false);
		if (this.session?.active) return this.session;
		if (this.connecting) return this.connecting;

		this.connecting = (async () => {
			let lastError: FriendlySshError | undefined;
			for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt++) {
				try {
					if (this.disposed) throw new FriendlySshError("SSH remote connection has been closed.", "connection", false);
					const session = await this.connectOnce();
					if (this.disposed) {
						session.invalidate(new FriendlySshError("SSH remote connection has been closed.", "connection", false));
					}
					session.checkActive();
					this.session = session;
					this.lastFailure = null;
					this.onStateChange?.("connected");
					return session;
				} catch (error) {
					lastError = this.normalizeConnectError(error);
					this.lastFailure = lastError.message;
					if (!lastError.retryable || this.disposed) break;
					if (attempt < RECONNECT_BACKOFF_MS.length - 1) {
						this.onStateChange?.("reconnecting");
						await new Promise<void>((resolve) => {
							if (this.disposed) return resolve();
							const finish = () => {
								clearTimeout(timer);
								this.cancelBackoff = null;
								resolve();
							};
							const timer = setTimeout(finish, RECONNECT_BACKOFF_MS[attempt]);
							this.cancelBackoff = finish;
						});
					}
				}
			}
			this.onStateChange?.("failed");
			throw lastError ?? new FriendlySshError(`SSH connection to ${this.target} failed.`, "unknown", false);
		})();

		try {
			return await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	private normalizeConnectError(error: unknown): FriendlySshError {
		if (this.hostKeyMismatch) {
			const message = this.hostKeyMismatch;
			this.hostKeyMismatch = null;
			return new FriendlySshError(message, "host-key", false);
		}
		return classifyConnectionError(error, this.target, CONFIG_PATH);
	}

	private async connectOnce(): Promise<ConnectionSession> {
		const config = await this.buildConnectConfig();
		if (this.disposed) throw new FriendlySshError("SSH remote connection has been closed.", "connection", false);
		const session = new ConnectionSession(this.target, (lost, error) => {
			if (this.session !== lost) return;
			this.session = null;
			if (!this.disposed) {
				this.lastFailure = error.message;
				this.onStateChange?.("reconnecting");
			}
		});
		this.handshaking = session;
		try {
			await session.connect(config);
			return session;
		} finally {
			if (this.handshaking === session) this.handshaking = null;
		}
	}

	private async sftpSession(): Promise<{ session: ConnectionSession; sftp: SFTPWrapper }> {
		const session = await this.ensureConnected();
		try {
			return { session, sftp: await session.getSftp() };
		} catch (error) {
			const friendly = this.classifySftpEstablishment(error, session);
			if (friendly.retryable) session.invalidate(friendly);
			throw friendly;
		}
	}

	async getSftp(): Promise<SFTPWrapper> {
		return (await this.sftpSession()).sftp;
	}

	/**
	 * Distinguish "the server refuses the SFTP subsystem" (jailed shells on
	 * shared hosting, e.g. exit code 254 while establishing the SFTP session)
	 * from genuine transport problems. The former triggers the shell-exec
	 * file-operations fallback instead of failing.
	 */
	private classifySftpEstablishment(error: unknown, session: ConnectionSession): FriendlySshError {
		const message = error instanceof Error ? error.message : String(error);
		// If the channel itself opened but the subsystem failed (exit code /
		// refusal), the transport is alive and exec channels can still be used.
		if (isFriendly(error)) return error;
		const transportAlive = session.active;
		if (transportAlive && /establishing SFTP session|subsystem|refused|exit code|exit signal/i.test(message)) {
			return new FriendlySshError(
				`The server ${this.target} did not allow an SFTP session (${message}). Falling back to shell-based file operations over the SSH connection.`,
				"sftp-unavailable",
				false,
			);
		}
		return classifyConnectionError(error, this.target, CONFIG_PATH);
	}

	/**
	 * Retry read-only SFTP operations once. A failed mutation may already have
	 * taken effect remotely, so leave its outcome to the caller.
	 */
	async withSftp<T>(operation: string, remotePath: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
		if (this.pathProblem) throw this.pathProblem;
		for (let attempt = 0; ; attempt++) {
			const { session, sftp } = await this.sftpSession();
			try {
				return await session.run(() => fn(sftp));
			} catch (error) {
				const friendly = classifySftpError(error, operation, remotePath);
				const transport = isFriendly(friendly) && friendly.retryable;
				if (transport) {
					session.invalidate(friendly);
					if (attempt === 0 && ["open", "access", "resolve", "readdir", "probe"].includes(operation)) continue;
				}
				throw friendly;
			}
		}
	}

	invalidateCurrent(): void {
		this.session?.invalidate(new FriendlySshError(`SSH connection to ${this.target} was interrupted.`, "connection", true));
	}

	/** Retry connecting, never a command whose acceptance may have been lost. */
	async execChannel(command: string): Promise<ClientChannel> {
		if (this.pathProblem) throw this.pathProblem;
		const session = await this.ensureConnected();
		try {
			return await session.exec(command);
		} catch (error) {
			const friendly = classifyConnectionError(error, this.target, CONFIG_PATH);
			if (friendly.retryable) session.invalidate(friendly);
			throw friendly;
		}
	}

	dispose(): void {
		this.disposed = true;
		const closed = new FriendlySshError("SSH remote connection has been closed.", "connection", false);
		this.handshaking?.invalidate(closed);
		this.cancelBackoff?.();
		this.session?.invalidate(closed);
	}
}
