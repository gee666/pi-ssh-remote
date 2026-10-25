import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startServer } from "./test-server.ts";
import { getKeybindings } from "@earendil-works/pi-tui";

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
let connectionLimit = Infinity;
const server = await startServer({ port, hostKeyPath: key, sandbox: root, maxConnections: () => connectionLimit });
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
	let widget: { render(width: number): string[] } | undefined;
	let widgetPlacement: string | undefined;
	const statuses: unknown[] = [];
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
	const ctx = { hasUI: false, sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined }, waitForIdle: async () => {}, ui: { setTitle() {}, setStatus(...args: unknown[]) { statuses.push(args); }, setWidget(_key: string, factory: Function | undefined, options?: { placement: string }) { widget = factory?.({}, { fg: (color: string, text: string) => `<${color}>${text}</${color}>` }); widgetPlacement = options?.placement; }, notify(message: string) { notifications.push(message); }, select: async () => selections.shift(), input: async () => inputs.shift() } } as unknown as ExtensionContext;
	extension(pi);
	return {
		pi, tools, registeredFlags, messages, notifications, selections, inputs, ctx, active: () => active,
		widget: () => widget, widgetPlacement: () => widgetPlacement, statuses,
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
					assert.equal(h.messages.length, 1);
					assert.equal(h.messages[0].content, `SSH connected to: test, CWD: ${remoteDir}`);
					assert.ok(h.prompt().includes(`Current working directory: ${mode === "ssh-local-first" ? process.cwd() : remoteDir}`));
				} finally { await h.stop(); }
			});
		}
		await t.test("SSH widget is one dim line below the editor only while connected", async (t) => {
			const h = harness(["ssh"]);
			let remote!: InstanceType<typeof import("../src/connection.ts").RemoteConnection>;
			const resolve = RemoteFsRouter.prototype.resolveProjectCwd;
			t.mock.method(RemoteFsRouter.prototype, "resolveProjectCwd", async function (this: InstanceType<typeof RemoteFsRouter>) {
				remote = this.remote;
				return resolve.call(this);
			});
			(h.ctx as { hasUI: boolean }).hasUI = true;
			h.selections.push("test", `1. test (${remoteDir})`);
			try {
				assert.equal(h.widget(), undefined);
				await h.start();
				assert.equal(h.widgetPlacement(), "belowEditor");
				assert.deepEqual(h.widget()!.render(1000), [`<dim>SSH: test:${remoteDir}</dim>`]);
				assert.equal(h.widget()!.render(20).length, 1);
				remote.invalidateCurrent();
				assert.equal(h.widget(), undefined);
				await h.run("bash", { command: "printf reconnected" });
				assert.deepEqual(h.widget()!.render(1000), [`<dim>SSH: test:${remoteDir}</dim>`]);
				assert.deepEqual(h.statuses, []);
			} finally { await h.stop(); }
			assert.equal(h.widget(), undefined);
		});
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
				assert.equal(h.messages.at(-1)!.content, `SSH connected to: test, CWD: ${remoteDir}`);
				const connectedMessages = [...h.messages];
				await h.command("ssh:include-local");
				await h.command("ssh:include-local");
				assert.deepEqual(h.messages, connectedMessages);
				assert.ok(h.notifications.some((message) => message.startsWith("Local tools ending in -local enabled")));
				assert.ok(h.active().includes("bash-local"));
				assert.match(await h.run("bash-local", { command: "pwd" }), new RegExp(process.cwd()));
				await h.command("ssh:bash", "printf REMOTE_COMMAND");
				assert.match(h.messages.at(-1)!.content, /REMOTE_COMMAND/);
				await h.command("ssh:bash-local", "printf LOCAL_COMMAND");
				assert.match(h.messages.at(-1)!.content, /LOCAL_COMMAND/);
				const beforeExclude = [...h.messages];
				await h.command("ssh:exclude-local");
				await h.command("ssh:exclude-local");
				assert.ok(!h.active().some((name) => name.endsWith("-local")));
				assert.deepEqual(h.messages, beforeExclude);
				assert.ok(h.notifications.includes("Local tools disabled."));
			} finally { await h.stop(); }
		});
		await t.test("same-location selections are silent and CWD changes send facts only", async () => {
			const original = await readFile(CONFIG_PATH, "utf8");
			const h = harness(["ssh"]);
			try {
				await h.start();
				const first = [...h.messages];
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("test", `1. test (${remoteDir})`);
				await h.command("ssh");
				h.inputs.push(remoteDir);
				await h.command("ssh:cwd");
				assert.deepEqual(h.messages, first);
				const next = path.join(remoteDir, "message-cwd");
				await mkdir(next);
				h.inputs.push(next);
				await h.command("ssh:cwd");
				assert.equal(h.messages.length, 2);
				assert.equal(h.messages[1].content, `SSH connection switched to: test, CWD: ${next}`);
				h.inputs.push(next);
				await h.command("ssh:cwd");
				assert.equal(h.messages.length, 2);
				assert.ok(!h.notifications.some((message) => message.startsWith("SSH remote connected:")));
			} finally { await h.stop(); await writeFile(CONFIG_PATH, original); }
		});
		await t.test("first connection after offline startup is announced after path validation", async (t) => {
			const h = harness(["ssh"]);
			(h.ctx as { hasUI: boolean }).hasUI = true;
			h.selections.push("test", `1. test (${remoteDir})`);
			const resolve = RemoteFsRouter.prototype.resolveProjectCwd;
			let first = true;
			t.mock.method(RemoteFsRouter.prototype, "resolveProjectCwd", async function (this: InstanceType<typeof RemoteFsRouter>) {
				if (first) { first = false; throw new FriendlySshError("Simulated offline startup", "connection", true); }
				return resolve.call(this);
			});
			try {
				await h.start();
				assert.equal(h.messages.length, 0);
				assert.equal(h.widget(), undefined, "offline startup must not show a widget");
				await h.run("bash", { command: "printf connected" });
				const deadline = Date.now() + 2000;
				while (h.messages.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
				assert.equal(h.messages.length, 1);
				assert.equal(h.messages[0].content, `SSH connected to: test, CWD: ${remoteDir}`);
				assert.deepEqual(h.widget()!.render(1000), [`<dim>SSH: test:${remoteDir}</dim>`]);
				await h.run("bash", { command: "printf again" });
				assert.equal(h.messages.length, 1);
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
				assert.equal(h.messages.at(-1)!.content, `SSH connection switched to: second, CWD: ${nextDir}`);
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
		await t.test("missing CWD prompts, preserves declined input, and creates parents only with consent", async () => {
			const h = harness(["ssh"]);
			const original = await readFile(CONFIG_PATH, "utf8");
			const missing = path.join(root, "new parent", "it's a folder");
			try {
				await h.start();
				(h.ctx as { hasUI: boolean }).hasUI = true;
				let prompts = 0;
				h.ctx.ui.confirm = async (title, message) => {
					assert.match(title, /doesn't exist, create it/);
					assert.equal(message, missing);
					assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
					return ++prompts === 2;
				};
				h.inputs.push(missing, missing);
				const prefills: (string | undefined)[] = [];
				h.ctx.ui.input = async (_title, prefill) => { prefills.push(prefill); return h.inputs.shift(); };
				await h.command("ssh:cwd");
				assert.equal(prompts, 2);
				assert.equal(prefills[1], missing);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), missing);
				assert.deepEqual(h.notifications, []);
			} finally { await h.stop(); await writeFile(CONFIG_PATH, original); }
		});
		await t.test("creation failure reports an error and preserves the active directory", async (t) => {
			const h = harness(["ssh"]);
			try {
				await h.start();
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.ctx.ui.confirm = async () => true;
				const missing = path.join(root, "cannot-create", "child");
				h.inputs.push(missing, remoteDir);
				let inputs = 0;
				h.ctx.ui.input = async (_title, prefill) => {
					if (++inputs === 2) {
						assert.equal(prefill, missing);
						assert.match(h.notifications.at(-1)!, /Could not create folder.*Permission denied creating folder/);
						assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
					}
					return h.inputs.shift();
				};
				t.mock.method(RemoteFsRouter.prototype, "mkdirs", async () => { throw new Error("Permission denied creating folder"); });
				await h.command("ssh:cwd");
				assert.equal(inputs, 2);
				assert.equal(h.notifications.length, 1);
				assert.match(h.notifications[0], /Permission denied creating folder/);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), remoteDir);
			} finally { t.mock.restoreAll(); await h.stop(); }
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
				t.mock.method(RemoteFsRouter.prototype, "resolveDirectory", async () => { resolves++; throw new Error("must not wait for SSH before input"); });
				h.ctx.ui.input = async () => { inputs++; assert.equal(resolves, 0); return undefined; };
				h.selections.push("test", "Enter a new path");
				await h.command("ssh");
				await h.command("ssh:cwd");
				assert.equal(inputs, 2);
				assert.equal(resolves, 0);
			} finally { await h.stop(); }
		});
		await t.test("three saved CWD switches then new-path hints reuse one SSH connection on a one-login server", async () => {
			const original = await readFile(CONFIG_PATH, "utf8");
			const h = harness(["ssh"]);
			try {
				await h.start();
				const count = server.connectionCount();
				connectionLimit = 1;
				Object.assign(h.ctx, { hasUI: true, mode: "tui" });
				const config = JSON.parse(original);
				for (let i = 0; i < 3; i++) {
					const saved = path.join(remoteDir, `saved-${i}`);
					await mkdir(saved);
					config.test.projects.push({ title: `Saved ${i}`, path: saved });
				}
				await writeFile(CONFIG_PATH, JSON.stringify(config));
				for (let i = 0; i < 3; i++) {
					const saved = config.test.projects[i + 1];
					h.selections.push("test", `${i + 2}. ${saved.title} (${saved.path})`);
					await h.command("ssh");
					assert.equal((await h.run("bash", { command: "pwd" })).trim(), saved.path);
				}
				const next = path.join(remoteDir, "fourth directory");
				await mkdir(next);
				await writeFile(path.join(next, "fourth.txt"), "FOURTH_DIRECTORY");
				let hintText = "";
				h.ctx.ui.custom = (async (factory: Function) => {
					let finish!: (value: unknown) => void;
					const result = new Promise((resolve) => { finish = resolve; });
					const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), finish);
					try {
						const deadline = Date.now() + 3000;
						do {
							hintText = component.render(120).join("\n");
							if (!hintText.includes("Loading directories...")) break;
							assert.ok(Date.now() < deadline, "hints did not load");
							await new Promise((resolve) => setTimeout(resolve, 10));
						} while (true);
						assert.match(hintText, /remote\//, "hints must list home, not the current project");
						assert.doesNotMatch(hintText, /Cannot fetch|failed/);
						component.handleInput(next);
						component.handleInput("\r");
						return await result;
					} finally { component.dispose(); }
				}) as typeof h.ctx.ui.custom;
				h.selections.push("test", "Enter a new path");
				await h.command("ssh");
				assert.equal(h.messages.length, 5);
				assert.equal(server.connectionCount(), count, "directory changes must not open additional SSH transports");
				assert.match(await h.run("read", { path: "fourth.txt" }), /FOURTH_DIRECTORY/);
				assert.equal((await h.run("bash", { command: "pwd" })).trim(), next);
			} finally {
				connectionLimit = Infinity;
				await h.stop();
				await writeFile(CONFIG_PATH, original);
			}
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
				t.mock.method(RemoteFsRouter.prototype, "resolveDirectory", async () => {
					throw new FriendlySshError("Injected temporary network failure", "connection", true);
				});
				(h.ctx as { hasUI: boolean }).hasUI = true;
				h.selections.push("test", `1. test (${remoteDir})`);
				await h.command("ssh");
				assert.ok(h.notifications.includes("Injected temporary network failure"));
				assert.equal(h.messages.length, 1, "a failed switch is not announced as successful");
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
				assert.equal(h.messages.length, 1);
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
				assert.equal(h.messages.at(-1)!.content, `SSH connection switched to: candidate, CWD: ${nextDir}`);
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
					assert.equal(h.messages.length, 1);
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
