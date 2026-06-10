/**
 * Configuration loading, validation, and project selection for the SSH
 * remote extension. The on-disk format is fully backward compatible with
 * earlier versions of this extension.
 */

import { readFile } from "node:fs/promises";
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

	const config: ConfigFile = {};
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

export async function loadProjects(): Promise<RemoteProject[]> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_PATH, "utf8");
	} catch {
		return [];
	}
	// Tolerate a UTF-8 BOM: PowerShell and Notepad routinely add one, and
	// strict JSON.parse rejects it.
	raw = raw.replace(/^\uFEFF/, "");
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
			const host = serverHost(serverName, server);
			const label = truncateMiddle(`${project.title} (${serverName} <${host}> - ${project.path})`);
			projects.push({ serverName, server, project, label });
		}
	}
	return projects;
}

function matchExactProject(projects: RemoteProject[], serverName: string, projectPath: string): RemoteProject | undefined {
	return projects.find((entry) => entry.serverName === serverName && entry.project.path === projectPath);
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
