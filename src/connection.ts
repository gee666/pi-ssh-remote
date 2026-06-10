/**
 * Persistent SSH connection management built on the pure-JS `ssh2` library.
 *
 * One `RemoteConnection` owns a single ssh2 Client with keepalives. All
 * operations go through `withSftp`/`exec`, which lazily (re)connect with a
 * single-flight connect promise and retry once after transport failures.
 *
 * No external binaries (ssh, sshpass) and nothing installed on the remote:
 * file operations use the SFTP subsystem, bash uses exec channels.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ssh2 from "ssh2";
import type { Client as ClientType, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import { CONFIG_PATH, KNOWN_HOSTS_PATH, expandHome, serverHost, type RemoteProject } from "./config.ts";
import { FriendlySshError, classifyConnectionError, classifySftpError, isFriendly } from "./errors.ts";

const { Client } = ssh2;

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
	private client: ClientType | null = null;
	private sftp: SFTPWrapper | null = null;
	private connecting: Promise<ClientType> | null = null;
	private sftpOpening: Promise<SFTPWrapper> | null = null;
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
	private async ensureConnected(): Promise<ClientType> {
		if (this.disposed) throw new FriendlySshError("SSH remote connection has been closed.", "connection", false);
		if (this.client) return this.client;
		if (this.connecting) return this.connecting;

		this.connecting = (async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt++) {
				try {
					const client = await this.connectOnce();
					if (this.disposed) {
						client.end();
						throw new FriendlySshError("SSH remote connection has been closed.", "connection", false);
					}
					this.client = client;
					this.lastFailure = null;
					this.onStateChange?.("connected");
					return client;
				} catch (error) {
					lastError = this.normalizeConnectError(error);
					this.lastFailure = (lastError as Error).message;
					if ((isFriendly(lastError) && !lastError.retryable) || this.disposed) break;
					if (attempt < RECONNECT_BACKOFF_MS.length - 1) {
						this.onStateChange?.("reconnecting");
						await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS[attempt]));
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

	private async connectOnce(): Promise<ClientType> {
		const config = await this.buildConnectConfig();
		return await new Promise<ClientType>((resolve, reject) => {
			const client = new Client();
			let settled = false;
			client.on("ready", () => {
				settled = true;
				// From now on, transport errors invalidate the cached client so
				// the next operation reconnects.
				client.on("error", () => this.invalidate(client));
				client.on("close", () => this.invalidate(client));
				client.on("end", () => this.invalidate(client));
				resolve(client);
			});
			client.on("error", (error) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			});
			client.on("close", () => {
				if (!settled) {
					settled = true;
					reject(new FriendlySshError(`SSH connection to ${this.target} closed during handshake.`, "connection", true));
				}
			});
			client.connect(config);
		});
	}

	private invalidate(client: ClientType): void {
		if (this.client === client) {
			this.client = null;
			this.sftp = null;
			if (!this.disposed) this.onStateChange?.("reconnecting");
		}
		try {
			client.end();
		} catch {
			// Already closed.
		}
	}

	async getSftp(): Promise<SFTPWrapper> {
		const client = await this.ensureConnected();
		if (this.sftp && this.client === client) return this.sftp;
		if (this.sftpOpening) return this.sftpOpening;
		this.sftpOpening = (async () => {
			const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
				client.sftp((error, sftp) => (error ? reject(this.classifySftpEstablishment(error, client)) : resolve(sftp)));
			});
			this.sftp = sftp;
			const forget = () => {
				if (this.sftp === sftp) this.sftp = null;
			};
			sftp.on("close", forget);
			// Without an error listener, an SFTP-session-level error would be an
			// unhandled 'error' event and crash the whole process.
			sftp.on("error", forget);
			return sftp;
		})();
		try {
			return await this.sftpOpening;
		} finally {
			this.sftpOpening = null;
		}
	}

	/**
	 * Distinguish "the server refuses the SFTP subsystem" (jailed shells on
	 * shared hosting, e.g. exit code 254 while establishing the SFTP session)
	 * from genuine transport problems. The former triggers the shell-exec
	 * file-operations fallback instead of failing.
	 */
	private classifySftpEstablishment(error: unknown, client: ClientType): FriendlySshError {
		const message = error instanceof Error ? error.message : String(error);
		// If the channel itself opened but the subsystem failed (exit code /
		// refusal), the transport is alive and exec channels can still be used.
		const transportAlive = this.client === client;
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
	 * Run an SFTP operation. Retries once with a fresh connection if the
	 * transport dropped mid-operation. SFTP file errors (ENOENT, EACCES) are
	 * never retried.
	 */
	async withSftp<T>(operation: string, remotePath: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
		if (this.pathProblem) throw this.pathProblem;
		for (let attempt = 0; ; attempt++) {
			let sftp: SFTPWrapper;
			try {
				sftp = await this.getSftp();
			} catch (error) {
				throw this.normalizeConnectError(error);
			}
			try {
				return await fn(sftp);
			} catch (error) {
				const friendly = classifySftpError(error, operation, remotePath);
				const transport = isFriendly(friendly) && friendly.retryable;
				if (transport) {
					this.invalidateCurrent();
					if (attempt === 0) continue;
				}
				throw friendly;
			}
		}
	}

	invalidateCurrent(): void {
		const client = this.client;
		if (client) this.invalidate(client);
	}

	/** Open an exec channel; retries connection establishment, not the command. */
	async execChannel(command: string): Promise<ClientChannel> {
		if (this.pathProblem) throw this.pathProblem;
		for (let attempt = 0; ; attempt++) {
			const client = await this.ensureConnected();
			try {
				return await new Promise<ClientChannel>((resolve, reject) => {
					client.exec(command, (error, stream) => (error ? reject(error) : resolve(stream)));
				});
			} catch (error) {
				const friendly = classifyConnectionError(error, this.target, CONFIG_PATH);
				if (friendly.retryable && attempt === 0) {
					this.invalidateCurrent();
					continue;
				}
				throw friendly;
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.invalidateCurrent();
	}
}
