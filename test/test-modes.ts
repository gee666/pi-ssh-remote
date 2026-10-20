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
const { FriendlySshError } = await import("../src/errors.ts");
const { RemoteFsRouter } = await import("../src/remote-fs.ts");
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
	const commands = new Map<string, { handler: Function }>();
	const messages: { content: string }[] = [];
	const notifications: string[] = [];
	const selections: (string | undefined)[] = [];
	const inputs: (string | undefined)[] = [];
	let active = ["read", "write", "edit", "bash"];
	const pi = {
		registerFlag(name: string) { registeredFlags.push(name); },
		registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
		sendMessage(message: { content: string }) { messages.push(message); },
		getFlag(name: string) { return flags.includes(name); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		getActiveTools() { return active; },
		setActiveTools(names: string[]) { active = names; },
		on(name: string, handler: Function) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI;
	const ctx = { hasUI: false, waitForIdle: async () => {}, ui: { setTitle() {}, setStatus() {}, notify(message: string) { notifications.push(message); }, select: async () => selections.shift(), input: async () => inputs.shift() } } as unknown as ExtensionContext;
	extension(pi);
	return {
		pi, tools, registeredFlags, messages, notifications, selections, inputs, ctx, active: () => active,
		command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
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
		await t.test("commands activate SSH from a local session and change access without clearing context", async () => {
			const h = harness([]);
			try {
				await h.start();
				assert.equal(h.tools.size, 0);
				await h.command("ssh");
				assert.match(await h.run("bash", { command: "pwd" }), new RegExp(remoteDir));
				assert.match(h.messages.at(-1)!.content, /context is unchanged/);
				await h.command("ssh:include-local");
				assert.ok(h.active().includes("bash-local"));
				assert.match(await h.run("bash-local", { command: "pwd" }), new RegExp(process.cwd()));
				await h.command("ssh:bash", "printf REMOTE_COMMAND");
				assert.match(h.messages.at(-1)!.content, /REMOTE_COMMAND/);
				await h.command("ssh:bash-local", "printf LOCAL_COMMAND");
				assert.match(h.messages.at(-1)!.content, /LOCAL_COMMAND/);
				await h.command("ssh:exclude-local");
				assert.ok(!h.active().some((name) => name.endsWith("-local")));
				assert.match(h.messages.at(-1)!.content, /local tools are disabled/);
			} finally { await h.stop(); }
		});
		await t.test("switches server and CWD, and a failed switch leaves tools on the previous connection", async () => {
			const h = harness(["ssh"]);
			try {
				await h.start();
				const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
				const nextDir = path.join(remoteDir, "another project");
				await mkdir(nextDir, { recursive: true });
				await writeFile(path.join(nextDir, "next.txt"), "NEXT_SERVER_CWD");
				config.second = { ...config.test, projects: [{ title: "Next", path: nextDir }, { title: "Missing", path: path.join(root, "missing") }] };
				await writeFile(CONFIG_PATH, JSON.stringify(config));
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("second", `1. Next (${nextDir})`);
				await h.command("ssh");
				assert.match(await h.run("read", { path: "next.txt" }), /NEXT_SERVER_CWD/);
				assert.ok(h.prompt().includes(nextDir));
				assert.match(h.messages.at(-1)!.content, /'second'/);
				h.selections.push("second", `2. Missing (${path.join(root, "missing")})`);
				await h.command("ssh");
				assert.match(await h.run("read", { path: "next.txt" }), /NEXT_SERVER_CWD/);
				delete config.second;
				await writeFile(CONFIG_PATH, JSON.stringify(config));
			} finally { await h.stop(); }
		});
		await t.test("interactive selection lists servers before paths and cancellation preserves connection", async () => {
			const h = harness(["ssh"]);
			try {
				await h.start();
				(h.ctx as { hasUI: boolean }).hasUI = true;
				const offered: string[][] = [];
				h.ctx.ui.select = (async (_title: string, options: string[]) => { offered.push(options); return offered.length === 1 ? "test" : undefined; }) as typeof h.ctx.ui.select;
				await h.command("ssh");
				assert.deepEqual(offered[0], ["test"]);
				assert.ok(offered[1].includes("Enter a new path"));
				assert.match(await h.run("bash", { command: "pwd" }), new RegExp(remoteDir));
			} finally { await h.stop(); }
		});
		await t.test("connections without folders prompt after connecting, save home, and allow new CWD input", async () => {
			const original = await readFile(CONFIG_PATH, "utf8");
			const config = JSON.parse(original);
			delete config.test.projects;
			await writeFile(CONFIG_PATH, JSON.stringify(config));
			const h = harness(["ssh"]);
			try {
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("test");
				h.inputs.push("");
				await h.start();
				assert.ok(h.prompt().includes(root));
				assert.ok(JSON.parse(await readFile(CONFIG_PATH, "utf8")).test.projects.some((p: { path: string }) => p.path === root));
				h.inputs.push(remoteDir);
				await h.command("ssh:cwd");
				assert.match(await h.run("read", { path: "remote.txt" }), /REMOTE_ONLY/);
				assert.ok(JSON.parse(await readFile(CONFIG_PATH, "utf8")).test.projects.some((p: { path: string }) => p.path === remoteDir));
			} finally { await h.stop(); await writeFile(CONFIG_PATH, original); }
		});
		await t.test("new-path and CWD inputs appear before any SSH directory resolution", async (t) => {
			const h = harness(["ssh"]);
			try {
				await h.start();
				(h.ctx as { hasUI: boolean }).hasUI = true;
				let resolves = 0;
				let inputs = 0;
				t.mock.method(RemoteFsRouter.prototype, "resolveProjectCwd", async () => { resolves++; throw new Error("must not wait for SSH before input"); });
				h.ctx.ui.input = async () => { inputs++; assert.equal(resolves, 0); return undefined; };
				h.selections.push("test", "Enter a new path");
				await h.command("ssh");
				await h.command("ssh:cwd");
				assert.equal(inputs, 2);
				assert.equal(resolves, 0);
			} finally { await h.stop(); }
		});
		await t.test("PuTTY import command updates by name, preserves paths, and does not activate SSH", async () => {
			const original = await readFile(CONFIG_PATH, "utf8");
			const source = path.join(root, "putty sessions");
			await mkdir(source);
			await writeFile(path.join(source, "test"), "HostName=changed.example\nUserName=deploy\nPortNumber=2222\nProtocol=ssh\n");
			await writeFile(path.join(source, "Imported%20new"), "HostName=new.example\nProtocol=ssh\n");
			const h = harness([]);
			try {
				await h.start();
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("Import all (2)");
				await h.command("ssh:import-putty", `"${source}"`);
				const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
				assert.deepEqual(Object.keys(config).sort(), ["Imported new", "test"]);
				assert.deepEqual(config.test.projects, JSON.parse(original).test.projects);
				assert.equal(config.test.hostName ?? config.test.host, "changed.example");
				assert.equal(config.test.port, 2222);
				assert.ok(h.notifications.some((message) => message.includes("1 added, 1 updated")));
				h.selections.push("Import all (2)");
				await h.command("ssh:import-putty", source);
				assert.ok(h.notifications.some((message) => message.includes("0 added, 0 updated, 2 unchanged")));
				assert.equal(h.tools.size, 0);
				assert.equal(h.prompt(), undefined);
			} finally { await h.stop(); await writeFile(CONFIG_PATH, original); }
		});
		await t.test("local-first include and exclude retire stale aliases without hiding unrelated tools", async () => {
			const h = harness(["ssh-local-first"]);
			try {
				await h.start();
				const unrelated = { ...h.tools.get("bash")!, name: "unrelated-tool" };
				h.pi.registerTool(unrelated);
				h.pi.setActiveTools([...h.active(), unrelated.name]);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), process.cwd());
				assert.equal((await h.run("bash-ssh", { command: "pwd" })).trim(), remoteDir);
				assert.equal(h.bash(), undefined);

				for (const command of ["ssh:include-local", "ssh:exclude-local", "ssh:include-local"]) {
					await h.command(command);
					const includeLocal = command === "ssh:include-local";
					assert.deepEqual([...h.active()].sort(), [
						...all, ...(includeLocal ? all.map((name) => name + "-local") : []), unrelated.name,
					].sort());
					assert.equal(h.tools.get(unrelated.name), unrelated);
					assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
					assert.match(await h.run("read", { path: "remote.txt" }), /REMOTE_ONLY/);
					assert.ok(h.bash(), "user bash switches from local to remote");
					assert.ok(!h.prompt().includes("Local-first SSH mode is active"));
					if (includeLocal) {
						assert.equal((await h.run("bash-local", { command: "pwd" })).trim(), process.cwd());
						assert.match(await h.run("read-local", { path: localFile }), /LOCAL_ONLY/);
					}
				}
			} finally { await h.stop(); }
		});
		await t.test("retryable switch failures preserve the previous connection instead of tolerating offline startup", async (t) => {
			const h = harness(["ssh"]);
			try {
				await h.start();
				const toolsBefore = new Map(h.tools);
				const activeBefore = [...h.active()];
				const inheritedBefore = process.env[INHERITED_PROJECT_ENV];
				const promptBefore = h.prompt();
				t.mock.method(RemoteFsRouter.prototype, "resolveProjectCwd", async () => {
					throw new FriendlySshError("Injected temporary network failure", "connection", true);
				});
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("test", `1. test (${remoteDir})`);
				await h.command("ssh");
				assert.ok(h.notifications.includes("Injected temporary network failure"));
				assert.equal(h.messages.length, 0, "a failed switch is not announced as successful");
				assert.deepEqual(h.active(), activeBefore);
				for (const [name, tool] of toolsBefore) assert.equal(h.tools.get(name), tool);
				assert.equal(process.env[INHERITED_PROJECT_ENV], inheritedBefore);
				assert.equal(h.prompt(), promptBefore);
				assert.match(await h.run("read", { path: "remote.txt" }), /REMOTE_ONLY/);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
			} finally { await h.stop(); }
		});
		await t.test("registration failure during a server switch restores previous definitions and permits retry", async (t) => {
			const original = await readFile(CONFIG_PATH, "utf8");
			const h = harness(["ssh"]);
			try {
				await h.start();
				const config = JSON.parse(original);
				const nextDir = path.join(root, "registration candidate");
				await mkdir(nextDir, { recursive: true });
				await writeFile(path.join(nextDir, "candidate.txt"), "CANDIDATE_ONLY\n");
				config.candidate = { ...config.test, projects: [{ title: "Candidate", path: nextDir }] };
				await writeFile(CONFIG_PATH, JSON.stringify(config));
				const toolsBefore = new Map(h.tools);
				const activeBefore = [...h.active()];
				const inheritedBefore = process.env[INHERITED_PROJECT_ENV];
				const promptBefore = h.prompt();
				const register = h.pi.registerTool.bind(h.pi);
				const attempted: string[] = [];
				let failed = false;
				t.mock.method(h.pi, "registerTool", (tool: ToolDefinition) => {
					attempted.push(tool.name);
					if (tool.name === "edit" && !failed) {
						failed = true;
						throw new Error("Injected registration failure");
					}
					register(tool);
				});
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("candidate", `1. Candidate (${nextDir})`);
				await h.command("ssh");
				assert.equal(failed, true);
				assert.deepEqual(attempted.slice(0, 3), ["read", "write", "edit"], "failure follows partial replacement");
				assert.ok(h.notifications.includes("Injected registration failure"));
				assert.equal(h.messages.length, 0);
				assert.deepEqual(h.active(), activeBefore);
				for (const [name, tool] of toolsBefore) assert.equal(h.tools.get(name), tool);
				assert.equal(process.env[INHERITED_PROJECT_ENV], inheritedBefore);
				assert.equal(h.prompt(), promptBefore);
				assert.match(await h.run("read", { path: "remote.txt" }), /REMOTE_ONLY/);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);

				h.selections.push("candidate", `1. Candidate (${nextDir})`);
				await h.command("ssh");
				assert.match(await h.run("read", { path: "candidate.txt" }), /CANDIDATE_ONLY/);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), nextDir);
				assert.equal(process.env[INHERITED_PROJECT_ENV], `candidate::${nextDir}`);
				assert.match(h.messages.at(-1)!.content, /'candidate'/);
			} finally { await h.stop(); await writeFile(CONFIG_PATH, original); }
		});
		for (const initialMode of ["ssh-local-first", "ssh-local"]) {
			await t.test(`${initialMode} restores mode and active aliases after partial registration failure`, async (t) => {
				const h = harness([initialMode]);
				try {
					await h.start();
					const toolsBefore = new Map(h.tools);
					const activeBefore = [...h.active()];
					const promptBefore = h.prompt();
					const inheritedBefore = process.env[INHERITED_PROJECT_ENV];
					const register = h.pi.registerTool.bind(h.pi);
					let failed = false;
					t.mock.method(h.pi, "registerTool", (tool: ToolDefinition) => {
						if (tool.name === "edit" && !failed) {
							failed = true;
							throw new Error("Injected mode registration failure");
						}
						register(tool);
					});
					const command = initialMode === "ssh-local-first" ? "ssh:include-local" : "ssh:exclude-local";
					await h.command(command);
					assert.equal(failed, true);
					assert.ok(h.notifications.includes("Injected mode registration failure"));
					assert.equal(h.messages.length, 0);
					assert.deepEqual(h.active(), activeBefore);
					for (const [name, tool] of toolsBefore) assert.equal(h.tools.get(name), tool);
					assert.equal(h.prompt(), promptBefore);
					assert.equal(process.env[INHERITED_PROJECT_ENV], inheritedBefore);
					const localFirst = initialMode === "ssh-local-first";
					assert.equal(h.bash() === undefined, localFirst);
					assert.equal((await h.run("bash", { command: "pwd" })).trim(), localFirst ? process.cwd() : remoteDir);
					assert.match(await h.run(localFirst ? "read-ssh" : "read", { path: "remote.txt" }), /REMOTE_ONLY/);
					assert.match(await h.run(localFirst ? "read" : "read-local", { path: localFile }), /LOCAL_ONLY/);

					await h.command(command);
					assert.deepEqual([...h.active()].sort(), [
						...all, ...(localFirst ? all.map((name) => name + "-local") : []),
					].sort());
					assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
				} finally { await h.stop(); }
			});
		}
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
