/** PuTTY saved-session discovery. Explicit sources work on any platform. */
import childProcess from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { expandHome, type ServerConfig } from "./config.ts";

const REGISTRY_KEY = "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions";
const SESSION_KEY = /^(?:HKEY_CURRENT_USER|HKCU)\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\\]+)$/i;
const FIELDS = new Set(["HostName", "UserName", "PortNumber", "Protocol", "PublicKeyFile"]);
type Session = { name: string; values: Record<string, string> };
export type PuttyDiscovery = { connections: Record<string, ServerConfig>; warnings: string[] };

function sessionName(value: string): string {
	// PuTTY escapes bytes, not '+' characters. Decode each run separately so a
	// stray '%' does not prevent other escapes in the name from being decoded.
	return value.replace(/(?:%[\da-f]{2})+/gi, (escaped) => {
		try { return decodeURIComponent(escaped); } catch { return escaped; }
	});
}

function decodeExport(raw: Buffer): string {
	if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
	return raw.toString("utf8").replace(/^\uFEFF/, "");
}

function unquote(value: string): string {
	return value.replace(/\\([\\"])/g, "$1");
}

function registrySessions(raw: string, exported: boolean): Session[] {
	const sessions: Session[] = [];
	let current: Session | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (exported ? trimmed.startsWith("[") : /^(?:HKEY_|HKCU\\)/i.test(trimmed)) {
			const key = exported ? trimmed.slice(1, -1) : trimmed;
			const match = SESSION_KEY.exec(key);
			current = match ? { name: match[1], values: Object.create(null) } : undefined;
			if (current) sessions.push(current);
			continue;
		}
		if (!current) continue;
		if (exported) {
			const match = /^"([^"\\]+)"\s*=\s*(?:"((?:[^"\\]|\\.)*)"|dword:([\da-f]{1,8}))\s*$/i.exec(trimmed);
			if (match && FIELDS.has(match[1])) {
				current.values[match[1]] = match[3] !== undefined ? String(parseInt(match[3], 16)) : unquote(match[2]);
			}
		} else {
			const match = /^\s*(\S+)\s+REG_(SZ|DWORD)\s+(.*?)\s*$/i.exec(line);
			if (match && FIELDS.has(match[1])) {
				current.values[match[1]] = match[2].toUpperCase() === "DWORD" && /^0x[\da-f]+$/i.test(match[3])
					? String(parseInt(match[3].slice(2), 16)) : match[3];
			}
		}
	}
	return sessions;
}

async function registryQuery(): Promise<string> {
	return new Promise((resolve, reject) => {
		childProcess.execFile("reg.exe", ["query", REGISTRY_KEY, "/s"], {
			encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
		}, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function safeText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function message(error: unknown): string {
	return safeText(error instanceof Error ? error.message : String(error));
}

async function compatibleIdentity(key: string, name: string, warnings: string[]): Promise<string | undefined> {
	const warn = (reason: string) => {
		warnings.push(safeText(`PuTTY session '${name}': identity '${key}' was not imported. ${reason}`));
	};
	if (/\.ppk$/i.test(key)) {
		warn("PuTTY PPK keys are unsupported by ssh2. Convert the key to OpenSSH format with PuTTYgen.");
		return;
	}
	try {
		// Do not resolve foreign/relative paths against the import directory or
		// guess key compatibility from a filename extension.
		const keyPath = expandHome(key);
		const info = await stat(keyPath);
		if (!info.isFile() || info.size > 1024 * 1024) {
			warn("The key must be a regular file no larger than 1 MiB.");
			return;
		}
		const content = await readFile(keyPath);
		if (/^PuTTY-User-Key-File-/m.test(content.toString("utf8"))) {
			warn("PuTTY PPK keys are unsupported by ssh2. Convert the key to OpenSSH format with PuTTYgen.");
			return;
		}
		const parsed = ssh2.utils.parseKey(content);
		if (parsed instanceof Error || !parsed.isPrivateKey()) {
			warn("The key is not a verified ssh2-compatible private key. Encrypted keys need manual configuration.");
			return;
		}
		return key;
	} catch (error) {
		warn(`Cannot read or verify this key: ${message(error)}`);
	}
}

/** Discover local sessions, a .reg export, or a Unix sessions directory.
 * Missing local Unix storage is normal; explicit-source and registry failures
 * are reported in warnings. Discovery never modifies the config or key files.
 */
export async function discoverPuttySessions(source?: string): Promise<PuttyDiscovery> {
	const result: PuttyDiscovery = { connections: Object.create(null), warnings: [] };
	const warn = (warning: string) => result.warnings.push(safeText(warning));
	const sessions: Session[] = [];
	const location = source === undefined ? path.join(homedir(), ".putty", "sessions") : expandHome(source);
	try {
		if (source === undefined && process.platform === "win32") {
			sessions.push(...registrySessions(await registryQuery(), false));
		} else if ((await stat(location)).isDirectory()) {
			const entries = await readdir(location, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isFile()) continue;
				try {
					const raw = await readFile(path.join(location, entry.name), "utf8");
					const values: Record<string, string> = Object.create(null);
					for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
						const equals = line.indexOf("=");
						const field = line.slice(0, equals).trim();
						if (equals >= 0 && FIELDS.has(field)) values[field] = line.slice(equals + 1);
					}
					sessions.push({ name: entry.name, values });
				} catch (error) {
					warn(`Cannot read PuTTY session '${entry.name}': ${message(error)}`);
				}
			}
		} else {
			const raw = decodeExport(await readFile(location));
			if (!/^(?:Windows Registry Editor Version 5\.00|REGEDIT4)\s*$/m.test(raw.replace(/\r/g, ""))) {
				warn(`PuTTY source '${location}' is not a .reg export.`);
				return result;
			}
			sessions.push(...registrySessions(raw, true));
		}
	} catch (error) {
		const missingLocal = source === undefined && process.platform !== "win32" && (error as NodeJS.ErrnoException).code === "ENOENT";
		if (missingLocal && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
			try {
				sessions.push(...registrySessions(await registryQuery(), false));
			} catch (registryError) {
				warn(`Cannot discover PuTTY sessions from '${REGISTRY_KEY}': ${message(registryError)}`);
				return result;
			}
		} else {
			if (!missingLocal) warn(`Cannot discover PuTTY sessions from '${source === undefined && process.platform === "win32" ? REGISTRY_KEY : location}': ${message(error)}`);
			return result;
		}
	}

	for (const session of sessions) {
		const name = sessionName(session.name);
		const values = session.values;
		if (CONTROL_CHARACTERS.test(name) || [values.HostName, values.UserName, values.PublicKeyFile].some((value) => value !== undefined && CONTROL_CHARACTERS.test(value))) {
			warn(`PuTTY session '${name}' was skipped: control characters in its name or connection fields.`);
			continue;
		}
		const host = values.HostName?.trim();
		if (!name.trim() || name.trim().toLowerCase() === "default settings" || !host) continue;
		if ((values.Protocol ?? "ssh").trim().toLowerCase() !== "ssh") continue;
		const port = values.PortNumber === undefined ? 22 : Number(values.PortNumber);
		if (!/^\d+$/.test(values.PortNumber ?? "22") || !Number.isInteger(port) || port < 1 || port > 65535) {
			warn(`PuTTY session '${name}' was skipped: invalid SSH port '${values.PortNumber}'.`);
			continue;
		}
		const server: ServerConfig = { host, port };
		if (values.UserName?.trim()) server.user = values.UserName.trim();
		const key = values.PublicKeyFile?.trim();
		if (key) {
			const identity = await compatibleIdentity(key, name, result.warnings);
			if (identity) server.identityFile = identity;
		}
		if (Object.hasOwn(result.connections, name)) warn(`Duplicate PuTTY session '${name}': using the last entry.`);
		result.connections[name] = server;
	}
	return result;
}
