/**
 * Typed, friendly error handling for the SSH remote extension.
 *
 * ssh2 reports transport problems with structured fields (`level`, `code`),
 * and SFTP failures with numeric status codes. We map those to actionable
 * messages instead of parsing stderr text.
 */

export type SshFailureKind =
	| "auth"
	| "host-key"
	| "dns"
	| "timeout"
	| "connection"
	| "missing-key"
	| "remote-path"
	| "remote-permission"
	| "cancelled"
	| "config"
	| "unknown";

export class FriendlySshError extends Error {
	readonly kind: SshFailureKind;
	readonly retryable: boolean;

	constructor(message: string, kind: SshFailureKind, retryable = false) {
		super(message);
		this.name = "FriendlySshError";
		this.kind = kind;
		this.retryable = retryable;
	}
}

/** SFTP status codes (SSH_FXP_STATUS) used by ssh2's SFTP errors. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_FAILURE = 4;
const SFTP_OP_UNSUPPORTED = 8;

type Ssh2LikeError = Error & {
	level?: string;
	code?: number | string;
	errno?: number;
};

export function isFriendly(error: unknown): error is FriendlySshError {
	return error instanceof FriendlySshError;
}

/**
 * Map a connection-level (transport/auth/handshake) error to a friendly one.
 */
export function classifyConnectionError(error: unknown, target: string, configPath: string): FriendlySshError {
	if (isFriendly(error)) return error;
	const err = (error ?? new Error("Unknown SSH error")) as Ssh2LikeError;
	const message = err.message ?? String(error);
	const lower = message.toLowerCase();
	const code = typeof err.code === "string" ? err.code : undefined;

	if (err.level === "client-authentication" || lower.includes("all configured authentication methods failed")) {
		return new FriendlySshError(
			`SSH authentication to ${target} failed. Check user, IdentityFile, password settings in ${configPath}, and that the key/password is authorized on the server.`,
			"auth",
			false,
		);
	}
	if (lower.includes("host fingerprint") || lower.includes("host key")) {
		return new FriendlySshError(message, "host-key", false);
	}
	if (lower.includes("cannot parse privatekey") || lower.includes("unsupported key format") || lower.includes("encrypted private key detected")) {
		return new FriendlySshError(
			`The SSH private key for ${target} could not be used: ${message}. If the key has a passphrase, set "passphrase" or "passphraseEnv" in ${configPath}.`,
			"missing-key",
			false,
		);
	}
	if (code === "ENOTFOUND" || code === "EAI_AGAIN" || lower.includes("getaddrinfo")) {
		return new FriendlySshError(
			`SSH could not resolve the host for ${target}. Check the host/HostName in ${configPath}.`,
			"dns",
			false,
		);
	}
	if (code === "ECONNREFUSED") {
		return new FriendlySshError(
			`SSH connection to ${target} was refused. Check that sshd is running and the port is correct.`,
			"connection",
			true,
		);
	}
	if (code === "ETIMEDOUT" || lower.includes("timed out while waiting for handshake") || lower.includes("timed out")) {
		return new FriendlySshError(
			`SSH connection to ${target} timed out. Check network access, host, port, and firewall.`,
			"timeout",
			true,
		);
	}
	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		code === "EHOSTUNREACH" ||
		code === "ENETUNREACH" ||
		err.level === "client-socket" ||
		err.level === "client-timeout" ||
		lower.includes("no response from server") ||
		lower.includes("connection lost") ||
		lower.includes("not connected") ||
		lower.includes("socket is closed")
	) {
		return new FriendlySshError(
			`SSH connection to ${target} was interrupted (${message}). It will be re-established automatically on the next operation.`,
			"connection",
			true,
		);
	}
	return new FriendlySshError(`SSH error while talking to ${target}: ${message}`, "unknown", false);
}

/**
 * Map an SFTP operation error to a friendly error. Keeps an `ENOENT`-style
 * prefix so pi's built-in tools recognize missing files the same way they do
 * for the local filesystem.
 */
export function classifySftpError(error: unknown, operation: string, remotePath: string): Error {
	if (isFriendly(error)) return error;
	const err = (error ?? new Error("Unknown SFTP error")) as Ssh2LikeError;
	const code = typeof err.code === "number" ? err.code : undefined;

	if (code === SFTP_NO_SUCH_FILE) {
		const friendly = new Error(`ENOENT: no such file or directory, ${operation} '${remotePath}'`) as Error & { code: string };
		friendly.code = "ENOENT";
		return friendly;
	}
	if (code === SFTP_PERMISSION_DENIED) {
		const friendly = new Error(`EACCES: permission denied, ${operation} '${remotePath}'`) as Error & { code: string };
		friendly.code = "EACCES";
		return friendly;
	}
	if (code === SFTP_FAILURE || code === SFTP_OP_UNSUPPORTED) {
		return new Error(`Remote SFTP ${operation} failed for '${remotePath}': ${err.message ?? "server reported a failure"}`);
	}
	// Anything else is most likely a dropped connection; surface as retryable.
	return classifyConnectionError(err, remotePath, "");
}

/** True when the error indicates the underlying connection is unusable. */
export function isTransportError(error: unknown): boolean {
	return isFriendly(error) ? error.retryable : false;
}
