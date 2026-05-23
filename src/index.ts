import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access as fsAccess, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type BashOperations,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

type ProjectConfig = {
	title: string;
	path: string;
};

type ServerConfig = {
	host?: string;
	Host?: string;
	hostName?: string;
	HostName?: string;
	user?: string;
	User?: string;
	port?: number | string;
	Port?: number | string;
	identityFile?: string;
	IdentityFile?: string;
	password?: string;
	Password?: string;
	passwordEnv?: string;
	PasswordEnv?: string;
	identitiesOnly?: boolean | string;
	IdentitiesOnly?: boolean | string;
	sshOptions?: Record<string, string | number | boolean>;
	projects?: ProjectConfig[];
};

type ConfigFile = Record<string, ServerConfig>;

type RemoteProject = {
	serverName: string;
	server: ServerConfig;
	project: ProjectConfig;
	label: string;
};

type ActiveRemote = {
	project: RemoteProject;
	remoteCwd: string;
	sshCommand: string;
	sshArgs: string[];
	target: string;
	sshEnv?: Record<string, string>;
	consecutiveFailures: number;
	lastFailure?: string;
};

type SshFailureKind = "auth" | "host-key" | "dns" | "timeout" | "connection" | "missing-key" | "missing-ssh" | "remote-path" | "remote-command" | "remote-permission" | "cancelled" | "unknown";

type SshExecOptions = {
	input?: Buffer | string;
	timeoutMs?: number;
	retries?: number;
	purpose: string;
};

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "ssh-remote-config.json");
const RED = "\u001b[31m";
const RESET = "\u001b[0m";
const DEFAULT_SSH_TIMEOUT_MS = 120_000;
const STARTUP_PROBE_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const INHERITED_PROJECT_ENV = "PI_CODING_AGENT_SSH_REMOTE_PROJECT";
const PROJECT_ENV_DELIMITER = "::";

class FriendlySshError extends Error {
	constructor(
		message: string,
		readonly kind: SshFailureKind,
		readonly retryable = false,
	) {
		super(message);
		this.name = "FriendlySshError";
	}
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truncateMiddle(value: string, max = 110): string {
	if (value.length <= max) return value;
	const left = Math.ceil((max - 3) / 2);
	const right = Math.floor((max - 3) / 2);
	return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function isPrintModeArgv(argv = process.argv): boolean {
	return argv.slice(2).some((arg) => arg === "-p" || arg === "--print" || arg.startsWith("--print="));
}

function formatInheritedProject(project: RemoteProject): string {
	return `${project.serverName}${PROJECT_ENV_DELIMITER}${project.project.path}`;
}

function redError(message: string): void {
	console.error(`${RED}${message}${RESET}`);
}

function normalizeBool(value: boolean | string | undefined): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return ["yes", "true", "1"].includes(value.toLowerCase());
	return undefined;
}

function isBoolString(value: string): boolean {
	return ["yes", "true", "1", "no", "false", "0"].includes(value.toLowerCase());
}

function getConfiguredPassword(server: ServerConfig): { password: string; source: "config" | "env" } | undefined {
	const passwordEnv = server.passwordEnv ?? server.PasswordEnv;
	if (passwordEnv) {
		const password = process.env[passwordEnv];
		if (password !== undefined) return { password, source: "env" };
	}
	const password = server.password ?? server.Password;
	return password !== undefined ? { password, source: "config" } : undefined;
}

function hasPasswordSetting(server: ServerConfig): boolean {
	return (server.password ?? server.Password ?? server.passwordEnv ?? server.PasswordEnv) !== undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validateConfig(value: unknown): ConfigFile {
	const root = asObject(value);
	if (!root) throw new Error(`SSH remote settings in ${CONFIG_PATH} must be a JSON object of servers.`);

	const config: ConfigFile = {};
	for (const [serverName, rawServer] of Object.entries(root)) {
		const serverObj = asObject(rawServer);
		if (!serverObj) throw new Error(`SSH remote server '${serverName}' in ${CONFIG_PATH} must be an object.`);

		const projects = serverObj.projects;
		if (projects !== undefined && !Array.isArray(projects)) {
			throw new Error(`SSH remote server '${serverName}' has invalid 'projects': expected an array.`);
		}

		const server = serverObj as ServerConfig;
		for (const field of ["host", "Host", "hostName", "HostName", "user", "User", "identityFile", "IdentityFile", "password", "Password", "passwordEnv", "PasswordEnv"] as const) {
			if (server[field] !== undefined && typeof server[field] !== "string") {
				throw new Error(`SSH remote server '${serverName}' has invalid '${field}': expected a string.`);
			}
		}
		const port = server.port ?? server.Port;
		if (port !== undefined && (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)) {
			throw new Error(`SSH remote server '${serverName}' has invalid port '${String(port)}'. Use a number from 1 to 65535.`);
		}
		const identitiesOnly = server.identitiesOnly ?? server.IdentitiesOnly;
		if (identitiesOnly !== undefined && typeof identitiesOnly !== "boolean" && (typeof identitiesOnly !== "string" || !isBoolString(identitiesOnly))) {
			throw new Error(`SSH remote server '${serverName}' has invalid IdentitiesOnly value '${String(identitiesOnly)}'. Use true/false or yes/no.`);
		}
		if (server.sshOptions !== undefined && !asObject(server.sshOptions)) {
			throw new Error(`SSH remote server '${serverName}' has invalid 'sshOptions': expected an object.`);
		}
		for (const [key, value] of Object.entries(server.sshOptions ?? {})) {
			if (value === null || !["string", "number", "boolean"].includes(typeof value)) {
				throw new Error(`SSH remote server '${serverName}' has invalid sshOptions.${key}: expected a string, number, or boolean.`);
			}
		}

		for (const [index, project] of (server.projects ?? []).entries()) {
			if (!asObject(project)) throw new Error(`SSH remote server '${serverName}' project #${index + 1} must be an object.`);
			if (typeof project.title !== "string" || project.title.trim() === "") {
				throw new Error(`SSH remote server '${serverName}' project #${index + 1} must have a non-empty string 'title'.`);
			}
			if (typeof project.path !== "string" || project.path.trim() === "") {
				throw new Error(`SSH remote server '${serverName}' project '${project.title ?? index + 1}' must have a non-empty string 'path'.`);
			}
		}
		config[serverName] = server;
	}
	return config;
}

async function checkLocalPrerequisites(server: ServerConfig): Promise<void> {
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("ssh", ["-V"], { stdio: "ignore" });
			child.on("error", reject);
			child.on("close", () => resolve());
		});
	} catch {
		throw new FriendlySshError("The local 'ssh' command was not found. Install OpenSSH client and try again.", "missing-ssh", false);
	}

	if (hasPasswordSetting(server)) {
		const passwordEnv = server.passwordEnv ?? server.PasswordEnv;
		if (passwordEnv && process.env[passwordEnv] === undefined) {
			throw new FriendlySshError(`SSH password environment variable '${passwordEnv}' is not set. Export it or remove passwordEnv in ${CONFIG_PATH}.`, "auth", false);
		}
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("sshpass", ["-V"], { stdio: "ignore" });
				child.on("error", reject);
				child.on("close", () => resolve());
			});
		} catch {
			throw new FriendlySshError("Password SSH auth requires the local 'sshpass' command. Install sshpass, or use an SSH key/agent instead.", "missing-ssh", false);
		}
	}

	const identityFile = server.identityFile ?? server.IdentityFile;
	if (!identityFile) return;
	const expanded = expandHome(identityFile);
	try {
		await fsAccess(expanded, fsConstants.R_OK);
	} catch {
		throw new FriendlySshError(`SSH identity file is not readable: ${expanded}. Check the path and permissions in ${CONFIG_PATH}.`, "missing-key", false);
	}
}

function buildSsh(serverName: string, server: ServerConfig): { command: string; args: string[]; target: string; env?: Record<string, string> } {
	const host = server.host ?? server.Host ?? server.hostName ?? server.HostName ?? serverName;
	const user = server.user ?? server.User;
	const port = server.port ?? server.Port;
	const identityFile = server.identityFile ?? server.IdentityFile;
	const identitiesOnly = normalizeBool(server.identitiesOnly ?? server.IdentitiesOnly);
	const passwordAuth = getConfiguredPassword(server);
	const target = user ? `${user}@${host}` : host;
	const sshArgs: string[] = ["-o", `BatchMode=${passwordAuth ? "no" : "yes"}`, "-o", "ConnectTimeout=10"];

	if (port !== undefined && String(port).trim() !== "") sshArgs.push("-p", String(port));
	if (identityFile) sshArgs.push("-i", expandHome(identityFile));
	if (identitiesOnly !== undefined) sshArgs.push("-o", `IdentitiesOnly=${identitiesOnly ? "yes" : "no"}`);
	for (const [key, value] of Object.entries(server.sshOptions ?? {})) {
		sshArgs.push("-o", `${key}=${String(value)}`);
	}

	if (!passwordAuth) return { command: "ssh", args: sshArgs, target };
	return { command: "sshpass", args: ["-e", "ssh", ...sshArgs], target, env: { SSHPASS: passwordAuth.password } };
}

function classifySshFailure(stderr: string, code: number | null, timedOut: boolean, spawnError: unknown, purpose: string): FriendlySshError {
	const raw = stderr.trim();
	const lower = raw.toLowerCase();
	const suffix = raw ? `\n\nSSH said:\n${raw}` : "";

	if (spawnError) return new FriendlySshError("The local 'ssh' command could not be started. Install OpenSSH client and ensure it is on PATH.", "missing-ssh", false);
	if (timedOut) return new FriendlySshError(`SSH ${purpose} timed out. Check network access, host, port, firewall, and server load.`, "timeout", true);
	if (lower.includes("identity file") && lower.includes("not accessible")) {
		return new FriendlySshError(`SSH identity file is missing or unreadable. Fix the IdentityFile path in ${CONFIG_PATH}.${suffix}`, "missing-key", false);
	}
	if (lower.includes("publickey") || lower.includes("permission denied (publickey") || lower.includes("permission denied, please try again") || (code === 255 && lower.includes("permission denied"))) {
		return new FriendlySshError(`SSH authentication failed. Check user, host, port, IdentityFile, IdentitiesOnly, and that the public key is authorized on the server.${suffix}`, "auth", false);
	}
	if (lower.includes("host key verification failed") || lower.includes("strict host key checking")) {
		return new FriendlySshError(`SSH host key verification failed. Connect once manually with ssh, verify the fingerprint, and update known_hosts.${suffix}`, "host-key", false);
	}
	if (lower.includes("could not resolve hostname") || lower.includes("name or service not known") || lower.includes("nodename nor servname")) {
		return new FriendlySshError(`SSH could not resolve the configured host. Check the server name/HostName in ${CONFIG_PATH}.${suffix}`, "dns", false);
	}
	if (lower.includes("connection refused")) {
		return new FriendlySshError(`SSH connection was refused. Check that sshd is running and the configured port is correct.${suffix}`, "connection", true);
	}
	if (lower.includes("connection timed out") || lower.includes("operation timed out") || lower.includes("no route to host") || lower.includes("network is unreachable")) {
		return new FriendlySshError(`SSH could not reach the server. Check network, VPN, firewall, host, and port.${suffix}`, "connection", true);
	}
	if (lower.includes("__pi_remote_path_missing__")) {
		return new FriendlySshError(`The configured remote project path does not exist or is not a directory. Update the project path in ${CONFIG_PATH}.${suffix}`, "remote-path", false);
	}
	if (lower.includes("permission denied")) {
		return new FriendlySshError(`The remote command did not have permission to complete ${purpose}.${suffix}`, "remote-permission", false);
	}
	if (code === 127 || lower.includes("command not found")) {
		return new FriendlySshError(`A required command was not found on the remote host while trying to ${purpose}.${suffix}`, "remote-command", false);
	}
	return new FriendlySshError(`SSH failed while trying to ${purpose}.${suffix}`, "unknown", code === 255);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sshExecBuffer(remote: ActiveRemote, command: string, options: SshExecOptions): Promise<Buffer> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
	const retries = options.retries ?? 1;
	let lastError: FriendlySshError | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const result = await runSshOnce(remote, command, { ...options, timeoutMs });
			remote.consecutiveFailures = 0;
			remote.lastFailure = undefined;
			return result;
		} catch (error) {
			lastError = error instanceof FriendlySshError ? error : new FriendlySshError(error instanceof Error ? error.message : String(error), "unknown", true);
			if (lastError.retryable) {
				remote.consecutiveFailures += 1;
				remote.lastFailure = lastError.message;
			} else {
				remote.consecutiveFailures = 0;
				remote.lastFailure = undefined;
			}
			if (!lastError.retryable || attempt >= retries || remote.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
			await delay(500 * (attempt + 1));
		}
	}

	if (remote.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && lastError?.retryable) {
		throw new FriendlySshError(
			`SSH remote appears unavailable after ${remote.consecutiveFailures} consecutive failures. Last error: ${lastError.message}`,
			lastError.kind,
			false,
		);
	}
	throw lastError ?? new FriendlySshError(`SSH failed while trying to ${options.purpose}.`, "unknown", false);
}

function sshSpawnEnv(remote: ActiveRemote): NodeJS.ProcessEnv | undefined {
	return remote.sshEnv ? { ...process.env, ...remote.sshEnv } : undefined;
}

function runSshOnce(remote: ActiveRemote, command: string, options: SshExecOptions & { timeoutMs: number }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(remote.sshCommand, [...remote.sshArgs, remote.target, command], { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: sshSpawnEnv(remote) });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		let spawnError: unknown;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeoutMs);
		const cleanup = () => clearTimeout(timer);
		const finishReject = (error: FriendlySshError) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		child.stdout?.on("data", (data: Buffer) => chunks.push(data));
		child.stderr?.on("data", (data: Buffer) => errChunks.push(data));
		child.stdin?.on("error", () => {
			// SSH may exit before consuming stdin (auth failure, missing path, etc.). The close handler reports the readable root cause.
		});
		child.on("error", (error) => {
			spawnError = error;
			finishReject(classifySshFailure("", null, false, spawnError, options.purpose));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (timedOut || code !== 0) reject(classifySshFailure(Buffer.concat(errChunks).toString(), code, timedOut, spawnError, options.purpose));
			else resolve(Buffer.concat(chunks));
		});
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

async function probeRemote(remote: ActiveRemote): Promise<void> {
	await sshExecBuffer(
		remote,
		`test -d ${shellQuote(remote.remoteCwd)} || { echo __pi_remote_path_missing__ >&2; exit 2; }; command -v cat >/dev/null && command -v mkdir >/dev/null && command -v test >/dev/null && command -v bash >/dev/null`,
		{ purpose: `connect to ${remote.project.label}`, timeoutMs: STARTUP_PROBE_TIMEOUT_MS, retries: 1 },
	);
}

function createRemoteReadOps(remote: ActiveRemote): ReadOperations {
	return {
		readFile: (filePath) => sshExecBuffer(remote, `cat -- ${shellQuote(filePath)}`, { purpose: `read ${filePath}`, retries: 1 }),
		access: (filePath) => sshExecBuffer(remote, `test -r -- ${shellQuote(filePath)}`, { purpose: `check read access for ${filePath}`, retries: 1 }).then(() => {}),
		detectImageMimeType: async (filePath) => {
			try {
				const result = await sshExecBuffer(remote, `file --mime-type -b -- ${shellQuote(filePath)}`, { purpose: `detect image type for ${filePath}`, retries: 0 });
				const mime = result.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: ActiveRemote): WriteOperations {
	return {
		mkdir: (dir) => sshExecBuffer(remote, `mkdir -p -- ${shellQuote(dir)}`, { purpose: `create directory ${dir}`, retries: 1 }).then(() => {}),
		writeFile: async (filePath, content) => {
			await sshExecBuffer(remote, `cat > ${shellQuote(filePath)}`, { input: content, purpose: `write ${filePath}`, retries: 1 });
		},
	};
}

function createRemoteEditOps(remote: ActiveRemote): EditOperations {
	const readOps = createRemoteReadOps(remote);
	const writeOps = createRemoteWriteOps(remote);
	return {
		readFile: readOps.readFile,
		access: readOps.access,
		writeFile: writeOps.writeFile,
	};
}

function createRemoteBashOps(remote: ActiveRemote, localCwd?: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const effectiveCwd = !cwd || cwd === localCwd ? remote.remoteCwd : cwd;
			const purpose = `run bash in ${effectiveCwd}`;
			let lastError: FriendlySshError | undefined;

			for (let attempt = 0; attempt <= 1; attempt++) {
				if (remote.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
					throw new FriendlySshError(
						`SSH remote appears unavailable after ${remote.consecutiveFailures} consecutive failures. Last error: ${remote.lastFailure ?? "unknown SSH failure"}`,
						"connection",
						false,
					);
				}

				const result = await runRemoteBashOnce(remote, command, effectiveCwd, { onData, signal, timeout, purpose, suppressStderr: attempt === 0 });
				if (result.kind === "success") {
					remote.consecutiveFailures = 0;
					remote.lastFailure = undefined;
					if (result.stderr.length > 0) onData(result.stderr);
					return { exitCode: result.exitCode };
				}

				lastError = result.error;
				if (lastError.retryable) {
					remote.consecutiveFailures += 1;
					remote.lastFailure = lastError.message;
				} else {
					remote.consecutiveFailures = 0;
					remote.lastFailure = undefined;
				}
				const canRetry = lastError.retryable && !result.sawStdout && attempt === 0 && !signal?.aborted && remote.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
				if (!canRetry) {
					if (result.stderr.length > 0) onData(result.stderr);
					onData(Buffer.from(`\n${lastError.message}\n`));
					return { exitCode: 255 };
				}
				await delay(500);
			}

			throw lastError ?? new FriendlySshError(`SSH failed while trying to ${purpose}.`, "unknown", false);
		},
	};
}

function runRemoteBashOnce(
	remote: ActiveRemote,
	command: string,
	effectiveCwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		purpose: string;
		suppressStderr: boolean;
	},
): Promise<{ kind: "success"; exitCode: number; stderr: Buffer } | { kind: "ssh-error"; error: FriendlySshError; stderr: Buffer; sawStdout: boolean }> {
	return new Promise((resolve, reject) => {
		const remoteScript = `cd ${shellQuote(effectiveCwd)} && ${command}`;
		const remoteCommand = `bash -lc ${shellQuote(remoteScript)}`;
		const child = spawn(remote.sshCommand, [...remote.sshArgs, remote.target, remoteCommand], { stdio: ["ignore", "pipe", "pipe"], env: sshSpawnEnv(remote) });
		const errChunks: Buffer[] = [];
		let sawStdout = false;
		let timedOut = false;
		let settled = false;
		let spawnError: unknown;
		const timer = options.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeout * 1000)
			: undefined;
		const onAbort = () => child.kill();
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			sawStdout = true;
			options.onData(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			errChunks.push(data);
			if (!options.suppressStderr) options.onData(data);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			spawnError = error;
			cleanup();
			reject(classifySshFailure("", null, false, spawnError, options.purpose));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			const stderr = Buffer.concat(errChunks);
			if (options.signal?.aborted) {
				resolve({ kind: "ssh-error", error: new FriendlySshError("SSH bash command was cancelled.", "cancelled", false), stderr, sawStdout });
				return;
			}
			if (timedOut || code === 255) {
				resolve({ kind: "ssh-error", error: classifySshFailure(stderr.toString(), code, timedOut, spawnError, options.purpose), stderr, sawStdout });
				return;
			}
			resolve({ kind: "success", exitCode: code ?? 1, stderr });
		});
	});
}

async function loadProjects(): Promise<RemoteProject[]> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_PATH, "utf8");
	} catch {
		return [];
	}
	if (!raw.trim()) return [];

	let config: ConfigFile;
	try {
		config = validateConfig(JSON.parse(raw));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`SSH remote settings in ${CONFIG_PATH} are not valid JSON. Fix the file and try again.`);
		throw error;
	}
	const projects: RemoteProject[] = [];
	for (const [serverName, server] of Object.entries(config)) {
		for (const project of server.projects ?? []) {
			const host = server.host ?? server.Host ?? server.hostName ?? server.HostName ?? serverName;
			const label = truncateMiddle(`${project.title} (${serverName} <${host}> - ${project.path})`);
			projects.push({ serverName, server, project, label });
		}
	}
	return projects;
}

function matchExactProject(projects: RemoteProject[], serverName: string, projectPath: string): RemoteProject | undefined {
	return projects.find((entry) => entry.serverName === serverName && entry.project.path === projectPath);
}

function matchInheritedProject(projects: RemoteProject[], wanted: string): RemoteProject | undefined {
	const trimmed = wanted.trim();
	if (!trimmed) return undefined;

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const obj = asObject(parsed);
		const serverName = obj?.serverName ?? obj?.server ?? obj?.serverId;
		const projectPath = obj?.projectPath ?? obj?.path;
		if (typeof serverName === "string" && typeof projectPath === "string") {
			const match = matchExactProject(projects, serverName, projectPath);
			if (match) return match;
		}
	} catch {
		// Not JSON; try the compact delimiter form below.
	}

	const delimiterIndex = trimmed.indexOf(PROJECT_ENV_DELIMITER);
	if (delimiterIndex > 0) {
		const serverName = trimmed.slice(0, delimiterIndex);
		const projectPath = trimmed.slice(delimiterIndex + PROJECT_ENV_DELIMITER.length);
		const match = matchExactProject(projects, serverName, projectPath);
		if (match) return match;
	}

	return matchProject(projects, trimmed);
}

function matchProject(projects: RemoteProject[], wanted: string): RemoteProject | undefined {
	const needle = wanted.toLowerCase();
	return projects.find((entry, index) => {
		return (
			String(index + 1) === wanted ||
			entry.project.title.toLowerCase() === needle ||
			entry.serverName.toLowerCase() === needle ||
			entry.project.path === wanted ||
			entry.label.toLowerCase() === needle
		);
	});
}

async function selectProject(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RemoteProject> {
	const projects = await loadProjects();
	if (projects.length === 0) {
		throw new Error(`SSH remote settings were not found. Add at least one server and project to ${CONFIG_PATH}.`);
	}

	const inheritedRequested = process.env[INHERITED_PROJECT_ENV];
	if (inheritedRequested) {
		const match = matchInheritedProject(projects, inheritedRequested);
		if (!match) throw new Error(`SSH remote project '${inheritedRequested}' from ${INHERITED_PROJECT_ENV} was not found in ${CONFIG_PATH}.`);
		return match;
	}

	const requested = pi.getFlag("ssh-remote-project") as string | undefined;
	if (requested) {
		const match = matchProject(projects, requested);
		if (!match) throw new Error(`SSH remote project '${requested}' was not found in ${CONFIG_PATH}.`);
		return match;
	}

	if (projects.length === 1 || !ctx.hasUI) {
		if (projects.length === 1) return projects[0];
		throw new Error(
			`Multiple SSH remote projects are configured. In non-interactive mode set --ssh-remote-project or ${INHERITED_PROJECT_ENV}.`,
		);
	}

	const labels = projects.map((project) => project.label);
	const choice = await ctx.ui.select("Select SSH remote project", labels);
	const selected = projects[labels.indexOf(choice ?? "")];
	if (!selected) throw new Error("No SSH remote project selected.");
	return selected;
}

function registerRemoteTools(pi: ExtensionAPI, remote: ActiveRemote, localCwd: string): void {
	pi.registerTool(createReadTool(remote.remoteCwd, { operations: createRemoteReadOps(remote) }));
	pi.registerTool(createWriteTool(remote.remoteCwd, { operations: createRemoteWriteOps(remote) }));
	pi.registerTool(createEditTool(remote.remoteCwd, { operations: createRemoteEditOps(remote) }));
	pi.registerTool(createBashTool(remote.remoteCwd, { operations: createRemoteBashOps(remote, localCwd) }));
}

export default function piSshRemote(pi: ExtensionAPI) {
	pi.registerFlag("ssh-remote", {
		description: "Enable SSH remote mode and select a project from ~/.pi/agent/ssh-remote-config.json",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("ssh-remote-project", {
		description: "Project selector for --ssh-remote in non-interactive mode (title, server name, path, or 1-based index)",
		type: "string",
	});

	let activeRemote: ActiveRemote | null = null;
	let fatalStartupError: string | null = null;
	const localCwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		const inheritedProject = process.env[INHERITED_PROJECT_ENV];
		const enabledByFlag = pi.getFlag("ssh-remote") === true && (!isPrintModeArgv() || !!inheritedProject);
		if (!enabledByFlag && !inheritedProject) return;

		try {
			fatalStartupError = null;
			const project = await selectProject(pi, ctx);
			process.env[INHERITED_PROJECT_ENV] = formatInheritedProject(project);
			await checkLocalPrerequisites(project.server);
			const ssh = buildSsh(project.serverName, project.server);
			const remote: ActiveRemote = {
				project,
				remoteCwd: project.project.path,
				sshCommand: ssh.command,
				sshArgs: ssh.args,
				target: ssh.target,
				sshEnv: ssh.env,
				consecutiveFailures: 0,
			};
			await probeRemote(remote);
			activeRemote = remote;
			registerRemoteTools(pi, activeRemote, localCwd);
			ctx.ui.setStatus("ssh-remote", `SSH: ${project.serverName}:${project.project.path}`);
			ctx.ui.setTitle(`SSH ${project.project.title}`);
			if (ctx.hasUI) ctx.ui.notify(`SSH remote connected: ${project.label}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fatalStartupError = message;
			activeRemote = null;
			process.exitCode = 1;
			redError(message);
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			ctx.shutdown();
		}
	});

	pi.on("input", () => {
		if (!(pi.getFlag("ssh-remote") || process.env[INHERITED_PROJECT_ENV]) || !fatalStartupError) return { action: "continue" };
		process.exitCode = 1;
		return { action: "handled" };
	});

	pi.on("user_bash", () => {
		if (!activeRemote) return;
		return { operations: createRemoteBashOps(activeRemote, localCwd) };
	});

	pi.on("before_agent_start", (event) => {
		if (!activeRemote) return;
		const remote = activeRemote;
		const replaced = event.systemPrompt
			.replaceAll(`Current working directory: ${localCwd}`, `Current working directory: ${remote.remoteCwd}`)
			.replaceAll(localCwd, remote.remoteCwd);
		return {
			systemPrompt: `${replaced}\n\nSSH remote mode is active. Treat ${remote.remoteCwd} on ${remote.project.serverName} as the current project root; the read, write, edit, and bash tools operate there transparently over SSH. If an SSH operation reports an authentication, host-key, network, timeout, or missing-path error, explain that error clearly to the user instead of repeatedly retrying the same action.`,
		};
	});
}
