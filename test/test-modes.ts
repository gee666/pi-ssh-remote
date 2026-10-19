import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startServer } from "./test-server.ts";

await mkdir("tmp", { recursive: true });
const root = await mkdtemp(path.resolve("tmp/modes-"));
const oldHome = process.env.HOME;
process.env.HOME = root;
const { default: extension } = await import("../src/index.ts");
const { CONFIG_PATH, INHERITED_PROJECT_ENV } = await import("../src/config.ts");
const oldInherited = process.env[INHERITED_PROJECT_ENV];
const remoteDir = path.join(root, "remote");
await mkdir(remoteDir);
await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
const key = path.join(root, "hostkey");
execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"], { timeout: 5000 });
const port = 12223;
const server = await startServer({ port, hostKeyPath: key, sandbox: root });
await writeFile(CONFIG_PATH, JSON.stringify({ test: {
	host: "127.0.0.1", port, user: "test", password: "testpass",
	projects: [{ title: "test", path: remoteDir }],
} }));
await writeFile(path.join(remoteDir, "remote.txt"), "REMOTE_ONLY\n");
const localFile = path.join(root, "local.txt");
await writeFile(localFile, "LOCAL_ONLY\n");

function harness(flags: string[], inherited = false) {
	if (inherited) process.env[INHERITED_PROJECT_ENV] = `test::${remoteDir}`;
	else delete process.env[INHERITED_PROJECT_ENV];
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Function>();
	const registeredFlags: string[] = [];
	let active = ["read", "write", "edit", "bash"];
	const pi = {
		registerFlag(name: string) { registeredFlags.push(name); },
		getFlag(name: string) { return flags.includes(name); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		getActiveTools() { return active; },
		setActiveTools(names: string[]) { active = names; },
		on(name: string, handler: Function) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, ui: { setTitle() {}, setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	extension(pi);
	return {
		tools, registeredFlags, active: () => active,
		start: () => handlers.get("session_start")!({}, ctx),
		stop: () => handlers.get("session_shutdown")!({}, ctx),
		bash: () => handlers.get("user_bash")!({}, ctx),
		prompt: () => handlers.get("before_agent_start")!({ systemPrompt: `Current working directory: ${process.cwd()}` }, ctx)?.systemPrompt,
		async run(name: string, args: unknown) {
			const result = await tools.get(name)!.execute("test", args, undefined, undefined, ctx);
			return result.content.map((c) => c.type === "text" ? c.text : "").join("\n");
		},
	};
}

const core = ["read", "write", "edit", "bash"];
const all = [...core, "grep", "find", "ls"];

test("startup modes and explicit opt-in", async (t) => {
	try {
		for (const flags of [[], ["ssh"], ["ssh-local"], ["ssh-local-first"]]) {
			await t.test(flags[0] ?? "inert", async () => {
				const h = harness(flags);
				try {
					assert.ok(h.registeredFlags.includes("ssh-local"));
					assert.ok(h.registeredFlags.includes("ssh-local-first"));
					assert.equal(h.tools.size, 0, "no tools registered before startup");
					await h.start();
					const mode = flags[0];
					if (!mode) {
						assert.equal(h.tools.size, 0);
						assert.equal(h.prompt(), undefined);
						assert.equal(h.bash(), undefined);
						return;
					}
					const expected = mode === "ssh" ? core : mode === "ssh-local"
						? [...all, ...all.map((n) => n + "-local")]
						: [...all, ...all.map((n) => n + "-ssh")];
					assert.deepEqual([...h.tools.keys()].sort(), expected.sort());
					assert.deepEqual(h.active().sort(), expected.sort());
					const remoteSuffix = mode === "ssh-local-first" ? "-ssh" : "";
					assert.match(await h.run("read" + remoteSuffix, { path: "remote.txt" }), /REMOTE_ONLY/);
					assert.match(await h.run("bash" + remoteSuffix, { command: "pwd" }), new RegExp(remoteDir));
					if (mode !== "ssh") {
						const suffix = mode === "ssh-local" ? "-local" : "";
						assert.match(await h.run("read" + suffix, { path: localFile }), /LOCAL_ONLY/);
						assert.match(await h.run("bash" + suffix, { command: "pwd" }), new RegExp(process.cwd()));
						await h.run("write" + suffix, { path: localFile, content: "LOCAL_CHANGED\n" });
						assert.equal(await readFile(localFile, "utf8"), "LOCAL_CHANGED\n");
						await writeFile(localFile, "LOCAL_ONLY\n");
						assert.match(h.prompt(), mode === "ssh-local" ? /read-local/ : /read-ssh/);
					}
					assert.equal(h.bash() === undefined, mode === "ssh-local-first");
					assert.ok(h.prompt().includes(`Current working directory: ${mode === "ssh-local-first" ? process.cwd() : remoteDir}`));
				} finally { await h.stop(); }
			});
		}
		await t.test("inherited project keeps legacy SSH-only mode", async () => {
			const h = harness([], true);
			try { await h.start(); assert.deepEqual([...h.tools.keys()].sort(), core.sort()); }
			finally { await h.stop(); }
		});
		await t.test("conflicting mode flags fail closed", async () => {
			const h = harness(["ssh", "ssh-local"]);
			try {
				await h.start();
				await assert.rejects(h.run("bash", { command: "pwd" }), /Choose only one/);
				assert.match(h.prompt(), /Choose only one/);
			} finally { await h.stop(); }
		});
		await writeFile(CONFIG_PATH, "{}");
		for (const mode of ["ssh", "ssh-local", "ssh-local-first"]) {
			await t.test(`${mode} fails closed without breaking explicit local access`, async () => {
				const h = harness([mode]);
				try {
					await h.start();
					const suffix = mode === "ssh-local-first" ? "-ssh" : "";
					for (const name of mode === "ssh" ? core : all) {
						await assert.rejects(h.run(name + suffix, { path: "remote.txt", command: "pwd", pattern: "*", content: "blocked", oldText: "x", newText: "y", edits: [{ oldText: "x", newText: "y" }] }), /SSH remote mode is active but unavailable/);
					}
					if (mode !== "ssh") {
						assert.match(await h.run("read" + (mode === "ssh-local" ? "-local" : ""), { path: localFile }), /LOCAL_ONLY/);
					}
					assert.equal(h.bash() === undefined, mode === "ssh-local-first");
					assert.match(h.prompt(), /setup failed/);
				} finally { await h.stop(); }
			});
		}
	} finally {
		server.dropConnections();
		server.close();
		if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
		if (oldInherited === undefined) delete process.env[INHERITED_PROJECT_ENV]; else process.env[INHERITED_PROJECT_ENV] = oldInherited;
		await rm(root, { recursive: true, force: true });
	}
});
