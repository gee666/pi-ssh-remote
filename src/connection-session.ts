import ssh2 from "ssh2";
import type { ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import { CONFIG_PATH } from "./config.ts";
import { FriendlySshError, classifyConnectionError } from "./errors.ts";

/** One transport and its pending work. A failed session is never reused. */
export class ConnectionSession {
	private readonly client = new ssh2.Client();
	private failure: FriendlySshError | null = null;
	private readonly pending = new Set<(error: FriendlySshError) => void>();
	private sftp: SFTPWrapper | null = null;
	private sftpOpening: Promise<SFTPWrapper> | null = null;

	private readonly target: string;
	private readonly onDisconnect: (session: ConnectionSession, error: FriendlySshError) => void;

	constructor(target: string, onDisconnect: (session: ConnectionSession, error: FriendlySshError) => void) {
		this.target = target;
		this.onDisconnect = onDisconnect;
		// Keep these listeners after teardown to absorb late transport events.
		this.client.on("error", (error) => this.invalidate(classifyConnectionError(error, target, CONFIG_PATH)));
		const closed = () => this.invalidate(new FriendlySshError(`SSH connection to ${target} closed.`, "connection", true));
		this.client.on("end", closed);
		this.client.on("close", closed);
	}

	get active(): boolean {
		return this.failure === null;
	}

	checkActive(): void {
		if (this.failure) throw this.failure;
	}

	async connect(config: ConnectConfig): Promise<void> {
		try {
			await this.run(() => new Promise<void>((resolve) => {
				this.client.once("ready", resolve);
				this.client.connect(config);
			}));
			this.checkActive();
		} catch (error) {
			this.invalidate(classifyConnectionError(error, this.target, CONFIG_PATH));
			throw error;
		}
	}

	invalidate(error: FriendlySshError): void {
		if (this.failure) return;
		this.failure = error;
		this.sftp = null;
		this.sftpOpening = null;
		for (const reject of this.pending) reject(error);
		this.pending.clear();
		try {
			// end() can leave pending callbacks on a half-open socket forever.
			this.client.destroy();
		} catch {
			// Preserve the original failure if teardown also fails.
		}
		this.onDisconnect(this, error);
	}

	/** Reject on transport loss even when ssh2 never calls an operation's callback. */
	run<T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.failure) return reject(this.failure);
			let settled = false;
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				this.pending.delete(fail);
				reject(error);
			};
			this.pending.add(fail);
			try {
				operation().then((value) => {
					if (settled) {
						try {
							discard?.(value);
						} catch {
							// A late channel may already have been torn down.
						}
						return;
					}
					settled = true;
					this.pending.delete(fail);
					resolve(value);
				}, fail);
			} catch (error) {
				fail(error);
			}
		});
	}

	async getSftp(): Promise<SFTPWrapper> {
		this.checkActive();
		if (this.sftp) return this.sftp;
		if (this.sftpOpening) return this.sftpOpening;
		this.sftpOpening = this.openSftp();
		try {
			return await this.sftpOpening;
		} finally {
			this.sftpOpening = null;
		}
	}

	private async openSftp(): Promise<SFTPWrapper> {
		const sftp = await this.run(() => new Promise<SFTPWrapper>((resolve, reject) => {
			this.client.sftp((error, stream) => {
				if (error) return reject(error);
				// Attach before resolving so a late callback cannot leave an
				// unhandled SFTP error, even after this transport was discarded.
				const forget = () => {
					if (this.sftp === stream) this.sftp = null;
				};
				stream.on("close", forget);
				stream.on("end", forget);
				stream.on("error", forget);
				resolve(stream);
			});
		}), (stream) => stream.destroy());
		this.checkActive();
		this.sftp = sftp;
		return sftp;
	}

	exec(command: string): Promise<ClientChannel> {
		return this.run(() => new Promise<ClientChannel>((resolve, reject) => {
			this.client.exec(command, (error, stream) => error ? reject(error) : resolve(stream));
		}), (stream) => stream.destroy());
	}
}
