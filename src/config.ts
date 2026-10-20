/**
 * Configuration loading, validation, and project selection for the SSH
 * remote extension. The on-disk format is fully backward compatible with
 * earlier versions of this extension.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ProjectConfig = {
	title: string;
	path: string;
};

export type ServerConfig = {
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
	passphrase?: string;
	passphraseEnv?: string;
	password?: string;
	Password?: string;
	passwordEnv?: string;
	PasswordEnv?: string;
	identitiesOnly?: boolean | string;
	IdentitiesOnly?: boolean | string;
	/** Legacy OpenSSH -o options; accepted but ignored by the ssh2 backend. */
	sshOptions?: Record<string, string | number | boolean>;
	projects?: ProjectConfig[];
};

export type ConfigFile = Record<string, ServerConfig>;

export type RemoteProject = {
	serverName: string;
	server: ServerConfig;
	project: ProjectConfig;
	label: string;
};

export const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "ssh-remote-config.json");
export const KNOWN_HOSTS_PATH = path.join(homedir(), ".pi", "agent", "ssh-remote-known-hosts.json");
export const INHERITED_PROJECT_ENV = "PI_CODING_AGENT_SSH_REMOTE_PROJECT";
export const PROJECT_ENV_DELIMITER = "::";

export function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

export function truncateMiddle(value: string, max = 110): string {
	if (value.length <= max) return value;
	const left = Math.ceil((max - 3) / 2);
	const right = Math.floor((max - 3) / 2);
	return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

export function serverHost(serverName: string, server: ServerConfig): string {
	return server.host ?? server.Host ?? server.hostName ?? server.HostName ?? serverName;
}

export function formatInheritedProject(project: RemoteProject): string {
	return `${project.serverName}${PROJECT_ENV_DELIMITER}${project.project.path}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validateConfig(value: unknown): ConfigFile {
	const root = asObject(value);
	if (!root) throw new Error(`SSH remote settings in ${CONFIG_PATH} must be a JSON object of servers.`);

	const config: ConfigFile = Object.create(null);
	for (const [serverName, rawServer] of Object.entries(root)) {
		const serverObj = asObject(rawServer);
		if (!serverObj) throw new Error(`SSH remote server '${serverName}' in ${CONFIG_PATH} must be an object.`);

		const projects = serverObj.projects;
		if (projects !== undefined && !Array.isArray(projects)) {
			throw new Error(`SSH remote server '${serverName}' has invalid 'projects': expected an array.`);
		}

		const server = serverObj as ServerConfig;
		const stringFields = [
			"host", "Host", "hostName", "HostName", "user", "User",
			"identityFile", "IdentityFile", "passphrase", "passphraseEnv",
			"password", "Password", "passwordEnv", "PasswordEnv",
		] as const;
		for (const field of stringFields) {
			if (server[field] !== undefined && typeof server[field] !== "string") {
				throw new Error(`SSH remote server '${serverName}' has invalid '${field}': expected a string.`);
			}
		}
		const port = server.port ?? server.Port;
		if (port !== undefined && (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)) {
			throw new Error(`SSH remote server '${serverName}' has invalid port '${String(port)}'. Use a number from 1 to 65535.`);
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

function parseConfig(raw: string): ConfigFile {
	// Tolerate a UTF-8 BOM: PowerShell and Notepad routinely add one, and
	// strict JSON.parse rejects it.
	raw = raw.replace(/^\uFEFF/, "");
	if (!raw.trim()) return Object.create(null);

	try {
		return validateConfig(JSON.parse(raw));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`SSH remote settings in ${CONFIG_PATH} are not valid JSON. Fix the file and try again.`);
		throw error;
	}
}

function remoteProject(serverName: string, server: ServerConfig, project: ProjectConfig): RemoteProject {
	const host = serverHost(serverName, server);
	const label = truncateMiddle(`${project.title} (${serverName} <${host}> - ${project.path})`);
	return { serverName, server, project, label };
}

export async function loadProjects(): Promise<RemoteProject[]> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_PATH, "utf8");
	} catch {
		return [];
	}
	const config = parseConfig(raw);
	const projects: RemoteProject[] = [];
	for (const [serverName, server] of Object.entries(config)) {
		const serverProjects = server.projects?.length ? server.projects : [{ title: "Home", path: "." }];
		for (const project of serverProjects) {
			projects.push(remoteProject(serverName, server, project));
		}
	}
	return projects;
}

// Project saves and imports share a queue so neither can overwrite the other.
let pendingSave: Promise<void> = Promise.resolve();

function serializeSave<T>(operation: () => Promise<T>): Promise<T> {
	const save = pendingSave.then(operation);
	pendingSave = save.then(() => {}, () => {});
	return save;
}

async function writeConfigAtomically(config: ConfigFile): Promise<void> {
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	// An exclusive, private sibling allows atomic replacement on the same filesystem.
	const temporaryPath = `${CONFIG_PATH}.${randomUUID()}.tmp`;
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		try {
			await file.writeFile(`${JSON.stringify(config, null, "\t")}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, CONFIG_PATH);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

/** Append a path without rewriting authentication or other server settings. */
export function saveProjectPath(serverName: string, projectPath: string): Promise<void> {
	return serializeSave(async () => {
		if (typeof projectPath !== "string" || !projectPath.trim()) {
			throw new Error("SSH remote project path must be a non-empty string.");
		}
		// Unlike loading, saving must not ignore read or validation errors.
		const config = parseConfig(await readFile(CONFIG_PATH, "utf8"));
		const server = Object.hasOwn(config, serverName) ? config[serverName] : undefined;
		if (!server) throw new Error(`SSH remote server '${serverName}' is not configured in ${CONFIG_PATH}.`);
		if (server.projects?.some((project) => project.path === projectPath)) return;
		server.projects = [...(server.projects ?? []), {
			title: path.posix.basename(projectPath) || projectPath,
			path: projectPath,
		}];

		await writeConfigAtomically(config);
	});
}

export type ImportSummary = { added: number; updated: number; unchanged: number };

const IMPORTED_FIELDS = [
	["host", "Host", "hostName", "HostName"],
	["user", "User"],
	["port", "Port"],
	["identityFile", "IdentityFile"],
] as const;

/** Merge by exact server name. Only connection fields are imported.
 * An omitted user clears both username aliases to restore PuTTY's default login.
 * Omitted identities retain saved values, including manual OpenSSH conversions.
 * Existing field spelling, projects, credentials, and unknown settings are preserved.
 * Numeric and string ports compare equally. No write occurs for a no-op import.
 */
export function mergeImportedConnections(connections: Record<string, ServerConfig>): Promise<ImportSummary> {
	return serializeSave(async () => {
		const imported = validateConfig(connections);
		let config: ConfigFile;
		try {
			config = parseConfig(await readFile(CONFIG_PATH, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			config = Object.create(null);
		}
		const summary: ImportSummary = { added: 0, updated: 0, unchanged: 0 };
		for (const [name, incoming] of Object.entries(imported)) {
			const exists = Object.hasOwn(config, name);
			const server = exists ? config[name] : {};
			let changed = false;
			if (incoming.user === undefined && incoming.User === undefined) {
				for (const field of ["user", "User"] as const) {
					if (Object.hasOwn(server, field)) {
						delete server[field];
						changed = true;
					}
				}
			}
			for (const aliases of IMPORTED_FIELDS) {
				const sourceField = aliases.find((field) => incoming[field] !== undefined);
				if (!sourceField) continue;
				const targetField = aliases.find((field) => server[field] !== undefined) ?? aliases[0];
				const value = incoming[sourceField];
				const current = server[targetField];
				if (current === value || (aliases[0] === "port" && current !== undefined && Number(current) === Number(value))) continue;
				// Both fields belong to the same alias group. Assignment through a
				// record avoids the intersection of string and port field types.
				(server as Record<string, unknown>)[targetField] = value;
				changed = true;
			}
			if (!exists) {
				config[name] = server;
				summary.added++;
			} else if (changed) summary.updated++;
			else summary.unchanged++;
		}
		if (summary.added || summary.updated) await writeConfigAtomically(config);
		return summary;
	});
}

function matchExactProject(projects: RemoteProject[], serverName: string, projectPath: string): RemoteProject | undefined {
	const exact = projects.find((entry) => entry.serverName === serverName && entry.project.path === projectPath);
	if (exact) return exact;
	// Subagents inherit the resolved cwd, which need not be a saved project.
	const configured = projects.find((entry) => entry.serverName === serverName);
	if (!configured || !path.posix.isAbsolute(projectPath)) return undefined;
	return remoteProject(serverName, configured.server, {
		title: path.posix.basename(projectPath) || projectPath,
		path: projectPath,
	});
}

export function matchProject(projects: RemoteProject[], wanted: string): RemoteProject | undefined {
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

export function matchInheritedProject(projects: RemoteProject[], wanted: string): RemoteProject | undefined {
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
