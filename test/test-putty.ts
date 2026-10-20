import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

await mkdir("tmp", { recursive: true });
const root = await mkdtemp(path.resolve("tmp/putty-"));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const savedEnv = Object.fromEntries(["HOME", "USERPROFILE", "WSL_DISTRO_NAME", "WSL_INTEROP"].map((key) => [key, process.env[key]]));
process.env.HOME = root;
process.env.USERPROFILE = root;
const { CONFIG_PATH, mergeImportedConnections, saveProjectPath } = await import("../src/config.ts");
const { discoverPuttySessions } = await import("../src/putty.ts");

beforeEach(async () => {
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
	delete process.env.WSL_DISTRO_NAME;
	delete process.env.WSL_INTEROP;
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });
});

afterEach(() => {
	mock.restoreAll();
	Object.defineProperty(process, "platform", originalPlatform);
});

after(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

async function sessions(files: Record<string, string>, directory = path.join(root, "sessions")) {
	await mkdir(directory, { recursive: true });
	for (const [name, raw] of Object.entries(files)) await writeFile(path.join(directory, name), raw);
	return directory;
}

async function exportFile(raw: string | Buffer, name = "sessions.reg") {
	const file = path.join(root, name);
	await writeFile(file, raw);
	return file;
}

const registryRoot = "HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions";
const queryOutput = `${registryRoot}

${registryRoot}\\Work%20%26%20Prod
    HostName    REG_SZ    server.example
    UserName    REG_SZ    alice
    PortNumber    REG_DWORD    0x8ae
    Protocol    REG_SZ    ssh
    PublicKeyFile    REG_SZ    C:\\keys\\work.ppk

${registryRoot}\\Default%20Settings
    HostName    REG_SZ    default.example
${registryRoot}\\Telnet
    HostName    REG_SZ    telnet.example
    Protocol    REG_SZ    telnet
${registryRoot}\\Empty
    HostName    REG_SZ
${registryRoot}\\__proto__
    HostName    REG_SZ    safe.example
    PortNumber    REG_DWORD    0x16
`;

function mockQuery(output = queryOutput, error: Error | null = null) {
	return mock.method(childProcess, "execFile", (command: string, args: string[], options: Record<string, unknown>, callback: Function) => {
		assert.equal(command, "reg.exe");
		assert.deepEqual(args, ["query", "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions", "/s"]);
		assert.equal(options.timeout, 5000);
		assert.equal(options.windowsHide, true);
		assert.notEqual(options.shell, true);
		assert.ok(Number(options.maxBuffer) > 0);
		callback(error, output, "");
	});
}

async function writeConfig(config: unknown) {
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config));
}

async function readConfig() {
	return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

test("Unix sessions decode byte escapes, preserve literal + and malformed %, and skip defaults/non-SSH/empty hosts", async () => {
	const directory = await sessions({
		"Work%20%26%20Prod": "HostName= server.example \r\nUserName=alice\r\nPortNumber=2222\r\nProtocol=ssh\r\nIgnored=a=b\r\n",
		"caf%C3%A9+%25%ZZ": "HostName=cafe.example\nUserName=user=name\n",
		"Default%20Settings": "HostName=not-a-real-server\nProtocol=ssh\n",
		"telnet": "HostName=telnet.example\nProtocol=telnet\n",
		"raw": "HostName=raw.example\nProtocol=raw\n",
		"empty": "HostName=  \nProtocol=ssh\n",
		"missing": "UserName=alice\n",
		["__proto__"]: "HostName=safe.example\n",
	});
	await mkdir(path.join(directory, "not-a-session"));
	const result = await discoverPuttySessions(directory);
	assert.deepEqual({ ...result.connections }, {
		"Work & Prod": { host: "server.example", port: 2222, user: "alice" },
		"café+%%ZZ": { host: "cafe.example", port: 22, user: "user=name" },
		["__proto__"]: { host: "safe.example", port: 22 },
	});
	assert.deepEqual(result.warnings, []);
	assert.equal(Object.getPrototypeOf(result.connections), null);
	await assert.rejects(readFile(CONFIG_PATH), /ENOENT/, "discovery never saves configuration");
});

test("default Unix discovery, home expansion, and absent local storage", async () => {
	assert.deepEqual({ ...(await discoverPuttySessions()).connections }, {});
	assert.deepEqual((await discoverPuttySessions()).warnings, []);
	await sessions({ local: "HostName=local.example\n" }, path.join(root, ".putty", "sessions"));
	for (const source of [undefined, "~/.putty/sessions"]) {
		assert.equal((await discoverPuttySessions(source)).connections.local.host, "local.example");
	}
});

test(".reg UTF-16LE exports parse quoted strings, escaped paths, DWORD ports, and exact session sections", async () => {
	const raw = String.raw`Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Work%20%22prod%22]
"HostName"="server.example"
"UserName"="a\"b"
"PortNumber"=dword:000008ae
"Protocol"="ssh"
"PublicKeyFile"="C:\\Keys\\work.ppk"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Default%20Settings]
"HostName"="ignore.example"
[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\telnet]
"HostName"="ignore.example"
"Protocol"="telnet"
[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\empty]
"HostName"=""
[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\safe]
"HostName"="safe.example"
[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\safe\nested]
"HostName"="must-not-overwrite.example"
[HKEY_LOCAL_MACHINE\Software\SimonTatham\PuTTY\Sessions\other]
"HostName"="ignore.example"
`;
	const file = await exportFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(raw.replace(/\n/g, "\r\n"), "utf16le")]));
	const result = await discoverPuttySessions(file);
	assert.deepEqual({ ...result.connections }, {
		'Work "prod"': { host: "server.example", port: 2222, user: 'a"b' },
		safe: { host: "safe.example", port: 22 },
	});
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /C:\\Keys\\work\.ppk.*PPK.*OpenSSH/);
});

test("UTF-8 BOM and REGEDIT4 exports work cross-platform without registry execution", async () => {
	mock.method(childProcess, "execFile", () => { throw new Error("must not execute"); });
	for (const header of ["\uFEFFWindows Registry Editor Version 5.00", "REGEDIT4"]) {
		const file = await exportFile(`${header}\n[HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\\one%2520two]\n"HostName"="host.example"\n"PortNumber"=dword:00000016\n`);
		const result = await discoverPuttySessions(file);
		assert.deepEqual({ ...result.connections }, { "one%20two": { host: "host.example", port: 22 } });
		assert.deepEqual(result.warnings, []);
	}
});

test("Windows query uses execFile with fixed arguments and a timeout", async () => {
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
	const query = mockQuery();
	const result = await discoverPuttySessions();
	assert.deepEqual({ ...result.connections }, {
		"Work & Prod": { host: "server.example", port: 2222, user: "alice" },
		["__proto__"]: { host: "safe.example", port: 22 },
	});
	assert.equal(query.mock.callCount(), 1);
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /PPK.*unsupported/);
});

test("WSL falls back to registry only if local storage is absent, for either WSL indicator", async () => {
	const query = mockQuery();
	for (const indicator of ["WSL_DISTRO_NAME", "WSL_INTEROP"]) {
		process.env[indicator] = "wsl";
		assert.ok((await discoverPuttySessions()).connections["Work & Prod"]);
		delete process.env[indicator];
	}
	assert.equal(query.mock.callCount(), 2);
	process.env.WSL_DISTRO_NAME = "wsl";
	await sessions({}, path.join(root, ".putty", "sessions"));
	assert.equal(Object.keys((await discoverPuttySessions()).connections).length, 0);
	await discoverPuttySessions(path.join(root, "absent.reg"));
	assert.equal(query.mock.callCount(), 2, "empty local directories and explicit paths never fall back");
});

test("registry execution failures and missing or invalid explicit sources return warnings", async () => {
	const query = mockQuery("", new Error("registry unavailable or timed out"));
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
	assert.match((await discoverPuttySessions()).warnings[0], /registry unavailable or timed out/);
	Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
	process.env.WSL_INTEROP = "wsl";
	assert.match((await discoverPuttySessions()).warnings[0], /registry unavailable or timed out/);
	const absent = await discoverPuttySessions(path.join(root, "absent.reg"));
	assert.equal(Object.keys(absent.connections).length, 0);
	assert.match(absent.warnings[0], /ENOENT/);
	const invalid = await discoverPuttySessions(await exportFile("not registry data"));
	assert.match(invalid.warnings[0], /not a .reg export/);
	assert.equal(query.mock.callCount(), 2);
});

test("invalid ports are skipped without blocking valid sessions", async () => {
	const files = Object.fromEntries(["0", "65536", "-1", "NaN", "22x", "1.5", ""].map((port, index) => [String(index), `HostName=bad.example\nPortNumber=${port}\n`]));
	files.valid = "HostName=good.example\nPortNumber=65535\nProtocol=SSH\n";
	const result = await discoverPuttySessions(await sessions(files));
	assert.deepEqual(Object.keys(result.connections), ["valid"]);
	assert.equal(result.connections.valid.port, 65535);
	assert.equal(result.warnings.length, 7);
	assert.ok(result.warnings.every((warning) => /invalid SSH port/.test(warning)));
});

test("key import requires a readable ssh2-compatible private key, never PPK or a public key", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
	const keys: Record<string, string | Buffer> = {
		private: privateKey.export({ type: "pkcs1", format: "pem" }),
		public: publicKey.export({ type: "pkcs1", format: "pem" }),
		encrypted: privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }),
		"bad.ppk": "anything",
		"renamed-key": "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
		unknown: "not a private key",
	};
	for (const [name, content] of Object.entries(keys)) await writeFile(path.join(root, name), content);
	const files = Object.fromEntries([...Object.keys(keys), "missing"].map((key) => [key, `HostName=${key}.example\nPublicKeyFile=${path.join(root, key)}\n`]));
	const result = await discoverPuttySessions(await sessions(files));
	assert.equal(result.connections.private.identityFile, path.join(root, "private"));
	for (const key of [...Object.keys(keys), "missing"].filter((key) => key !== "private")) {
		assert.equal(result.connections[key].identityFile, undefined, key);
		assert.ok(result.warnings.some((warning) => warning.includes(`session '${key}'`)), key);
	}
	assert.equal(result.warnings.length, 6);
});

test("control characters in decoded names and connection values are rejected with escaped warnings", async () => {
	const files = {
		"bad%1B%5B31m": "HostName=bad.example\n",
		"bad%0Aname": "HostName=bad.example\n",
		host: "HostName=bad\u001b[31m.example\n",
		user: "HostName=host.example\nUserName=bad\tuser\n",
		key: "HostName=host.example\nPublicKeyFile=bad\u0007key\n",
		c1: "HostName=bad\u009b31m.example\n",
		valid: "HostName=good.example\n",
	};
	const result = await discoverPuttySessions(await sessions(files));
	assert.deepEqual(Object.keys(result.connections), ["valid"]);
	assert.equal(result.warnings.length, 6);
	assert.ok(result.warnings.every((warning) => /control characters/.test(warning) && !/[\u0000-\u001f\u007f-\u009f]/.test(warning)));
	assert.ok(result.warnings.some((warning) => warning.includes("\\u001b")));
	const file = await exportFile(`REGEDIT4\n[${registryRoot}\\bad%1Bname]\n"HostName"="bad.example"\n`);
	assert.equal(Object.keys((await discoverPuttySessions(file)).connections).length, 0);
});

test("key paths must be bounded regular files before they are read", async () => {
	const directory = path.join(root, "key-directory");
	await mkdir(directory);
	const oversized = path.join(root, "oversized");
	await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
	const files: Record<string, string> = {
		directory: `HostName=host.example\nPublicKeyFile=${directory}\n`,
		large: `HostName=host.example\nPublicKeyFile=${oversized}\n`,
	};
	if (originalPlatform.value === "linux") {
		const fifo = path.join(root, "key-fifo");
		childProcess.execFileSync("mkfifo", [fifo], { timeout: 5000 });
		files.fifo = `HostName=host.example\nPublicKeyFile=${fifo}\n`;
		files.device = "HostName=host.example\nPublicKeyFile=/dev/zero\n";
	}
	const result = await discoverPuttySessions(await sessions(files));
	assert.equal(result.warnings.length, Object.keys(files).length);
	assert.ok(result.warnings.every((warning) => /regular file no larger than 1 MiB/.test(warning)));
	assert.ok(Object.values(result.connections).every((connection) => connection.identityFile === undefined));
});

test("explicit source paths and session values cannot run shell commands", async () => {
	const query = mock.method(childProcess, "execFile", () => { throw new Error("must not execute"); });
	const directory = await sessions({ "$(touch%20owned)": "HostName=$(touch owned)\nUserName=a; touch owned\nPublicKeyFile=x; touch owned.ppk\n" }, path.join(root, "sessions; touch owned"));
	const result = await discoverPuttySessions(directory);
	assert.equal(result.connections["$(touch owned)"].host, "$(touch owned)");
	assert.equal(result.connections["$(touch owned)"].user, "a; touch owned");
	assert.match(result.warnings[0], /PPK/);
	assert.equal(query.mock.callCount(), 0);
	await assert.rejects(stat(path.join(root, "owned")), /ENOENT/);
});

test("merge creates private configuration and returns counts without inventing projects", async () => {
	const incoming = { work: { host: "work.example", user: "alice", port: 2222 }, other: { host: "work.example" } };
	const original = structuredClone(incoming);
	assert.deepEqual(await mergeImportedConnections(incoming), { added: 2, updated: 0, unchanged: 0 });
	assert.deepEqual(await readConfig(), incoming, "same host with different names is not deduplicated");
	assert.deepEqual(incoming, original, "caller input is not mutated");
	const info = await stat(CONFIG_PATH);
	if (originalPlatform.value !== "win32") assert.equal(info.mode & 0o777, 0o600);
	assert.deepEqual(await readdir(path.dirname(CONFIG_PATH)), [path.basename(CONFIG_PATH)]);
	const raw = await readFile(CONFIG_PATH, "utf8");
	assert.deepEqual(await mergeImportedConnections(incoming), { added: 0, updated: 0, unchanged: 2 });
	assert.equal(await readFile(CONFIG_PATH, "utf8"), raw);
	assert.equal((await stat(CONFIG_PATH)).ino, info.ino);
	assert.equal((await stat(CONFIG_PATH)).mtimeMs, info.mtimeMs);
});

test("merge updates by name and preserves aliases, projects, credentials, and user-added settings", async () => {
	const config = {
		work: {
			HostName: "old.example", User: "old-user", Port: "22", IdentityFile: "old-key",
			passwordEnv: "SSH_PASSWORD", passphraseEnv: "SSH_PHRASE", identitiesOnly: true,
			sshOptions: { ProxyJump: "gateway" }, custom: { color: "red" },
			projects: [{ title: "Keep title", path: "/srv/work", custom: { sort: 2 } }],
		},
		other: { host: "untouched.example", projects: [] },
	};
	await writeConfig(config);
	const incoming = { work: { host: "new.example", user: "alice", port: 2222, identityFile: "new-key", projects: [{ title: "Ignore", path: "/ignore" }], password: "ignore" } };
	assert.deepEqual(await mergeImportedConnections(incoming), { added: 0, updated: 1, unchanged: 0 });
	assert.deepEqual(await readConfig(), {
		...config,
		work: { ...config.work, HostName: "new.example", User: "alice", Port: 2222, IdentityFile: "new-key" },
	});
	assert.deepEqual(await mergeImportedConnections(incoming), { added: 0, updated: 0, unchanged: 1 });
});

test("omitted user clears both aliases while an omitted key preserves manual conversions after a PPK warning", async () => {
	await writeConfig({ work: { host: "old.example", user: "alice", User: "stale-alias", port: "22", identityFile: "my-manual-key", projects: [] } });
	const found = await discoverPuttySessions(await sessions({ work: "HostName=new.example\nPublicKeyFile=new.ppk\n" }));
	assert.match(found.warnings[0], /PPK/);
	assert.deepEqual(await mergeImportedConnections(found.connections), { added: 0, updated: 1, unchanged: 0 });
	assert.deepEqual(await readConfig(), { work: { host: "new.example", port: "22", identityFile: "my-manual-key", projects: [] } });
	const info = await stat(CONFIG_PATH);
	assert.deepEqual(await mergeImportedConnections(found.connections), { added: 0, updated: 0, unchanged: 1 });
	assert.equal((await stat(CONFIG_PATH)).ino, info.ino, "equivalent string and number ports do not rewrite");
});

test("merge handles prototype-like names, BOM files, and unchanged imports without rewriting formatting", async () => {
	const raw = '\uFEFF{"__proto__":{"Host":"safe.example","Port":"22","projects":[]},"constructor":{"host":"old.example"}}';
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, raw);
	assert.deepEqual(await mergeImportedConnections(JSON.parse('{"__proto__":{"host":"safe.example","port":22}}')), { added: 0, updated: 0, unchanged: 1 });
	assert.equal(await readFile(CONFIG_PATH, "utf8"), raw);
	assert.deepEqual(await mergeImportedConnections({ constructor: { host: "new.example" } }), { added: 0, updated: 1, unchanged: 0 });
	assert.equal((await readConfig()).constructor.host, "new.example");
	assert.deepEqual((await readConfig()).__proto__.projects, []);
});

test("empty imports never create configuration, and imports retain validation/read failures", async () => {
	assert.deepEqual(await mergeImportedConnections({}), { added: 0, updated: 0, unchanged: 0 });
	await assert.rejects(stat(CONFIG_PATH), /ENOENT/);
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	for (const raw of ["{", "[]", '{"work":{"projects":false}}']) {
		await writeFile(CONFIG_PATH, raw);
		await assert.rejects(mergeImportedConnections({ work: { host: "new.example" } }));
		assert.equal(await readFile(CONFIG_PATH, "utf8"), raw);
	}
	await writeConfig({ work: {} });
	await assert.rejects(mergeImportedConnections({ work: { port: 0 } }), /invalid port/);
	await assert.rejects(mergeImportedConnections({ work: { host: 123 } } as never), /expected a string/);
	assert.deepEqual(await readConfig(), { work: {} });
	await rm(CONFIG_PATH);
	await mkdir(CONFIG_PATH);
	await assert.rejects(mergeImportedConnections({ work: { host: "new.example" } }));
	await rm(CONFIG_PATH, { recursive: true });
	assert.deepEqual(await mergeImportedConnections({ work: { host: "new.example" } }), { added: 1, updated: 0, unchanged: 0 }, "failed imports do not poison the save queue");
});

test("imports and project saves share serialization and preserve concurrent edits", async () => {
	await writeConfig({ work: { host: "old.example" } });
	const results = await Promise.all([
		mergeImportedConnections({ work: { host: "new.example" }, added: { host: "added.example" } }),
		saveProjectPath("work", "/srv/one"),
		mergeImportedConnections({ work: { host: "new.example", user: "alice" } }),
		saveProjectPath("work", "/srv/two"),
		saveProjectPath("added", "/srv/three"),
		mergeImportedConnections({ work: { host: "new.example", user: "alice" } }),
	]);
	assert.deepEqual(results[0], { added: 1, updated: 1, unchanged: 0 });
	assert.deepEqual(results[2], { added: 0, updated: 1, unchanged: 0 });
	assert.deepEqual(results[5], { added: 0, updated: 0, unchanged: 1 });
	assert.deepEqual(await readConfig(), {
		work: { host: "new.example", user: "alice", projects: [{ title: "one", path: "/srv/one" }, { title: "two", path: "/srv/two" }] },
		added: { host: "added.example", projects: [{ title: "three", path: "/srv/three" }] },
	});
});

test("imports atomically replace existing files or symlinks, without temporary leftovers", { skip: originalPlatform.value === "win32" }, async () => {
	await writeConfig({ work: { host: "old.example" } });
	const previous = await stat(CONFIG_PATH);
	await mergeImportedConnections({ work: { host: "new.example" } });
	const next = await stat(CONFIG_PATH);
	assert.notEqual(next.ino, previous.ino);
	assert.equal(next.mode & 0o777, 0o600);
	await rm(CONFIG_PATH);
	const target = path.join(root, "target.json");
	const raw = '{"work":{"host":"old.example"}}';
	await writeFile(target, raw);
	await symlink(target, CONFIG_PATH);
	await mergeImportedConnections({ work: { host: "new.example" } });
	assert.equal(await readFile(target, "utf8"), raw);
	assert.equal((await readConfig()).work.host, "new.example");
	assert.deepEqual(await readdir(path.dirname(CONFIG_PATH)), [path.basename(CONFIG_PATH)]);
});
