import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ClientChannel } from "ssh2";
import { createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";
import type { RemoteConnection } from "../src/connection.ts";
import { createRemoteSearchTools } from "../src/search-tools.ts";

const hasRg = spawnSync("rg", ["--version"], { timeout: 2000 }).status === 0;
const hasFd = spawnSync("fd", ["--version"], { timeout: 2000 }).status === 0;

// Emulate only the SSH exec-channel boundary. Real bash/rg/fd interpret the
// generated command, but no SSH server or credentials are needed. The local
// and remote project directories are deliberately different.
async function fixture() {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(resolve("tmp/search-tools-"));
	const local = join(root, "local");
	const project = join(root, "remote ' $project");
	const home = join(root, "remote-home");
	await Promise.all([local, project, home].map((p) => mkdir(p)));
	await writeFile(join(local, "LOCAL_ONLY"), "local secret");
	const commands: string[] = [];
	const remote = {
		target: "test-host", remoteCwd: project,
		async execChannel(command: string) {
			commands.push(command);
			const channel = new EventEmitter() as ClientChannel;
			const child = spawn("bash", ["-c", command], {
				env: { ...process.env, HOME: home },
				stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
			});
			Object.assign(channel, { stderr: child.stderr, close: () => child.kill() });
			child.stdout.on("data", (chunk) => channel.emit("data", chunk));
			child.on("error", (error) => channel.emit("error", error));
			child.on("exit", (code) => channel.emit("exit", code));
			child.on("close", (code) => channel.emit("close", code));
			return channel;
		},
		invalidateCurrent() { throw new Error("Unexpected connection invalidation"); },
	} as unknown as RemoteConnection;
	return { root, local, project, home, commands, remote,
		tools: createRemoteSearchTools(remote, local),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

// Synthetic streams exercise diagnostics, chunk boundaries and commands that
// would otherwise keep running after the requested match count is reached.
function scriptedRemote(send: (channel: ClientChannel) => void) {
	const state = { closes: 0, invalidations: 0 };
	const remote = {
		target: "stream-test", remoteCwd: "/remote",
		async execChannel() {
			const channel = new EventEmitter() as ClientChannel;
			Object.assign(channel, { stderr: new PassThrough(), close() {
				state.closes++;
				queueMicrotask(() => {
					// Deliberate closure need not provide a successful exit status.
					channel.emit("exit", 143);
					channel.emit("close", 143);
				});
			} });
			setImmediate(() => {
				try { send(channel); } catch (error) { channel.emit("error", error); }
			});
			return channel;
		},
		invalidateCurrent() { state.invalidations++; },
	} as unknown as RemoteConnection;
	return { state, tools: createRemoteSearchTools(remote, "/local") };
}

function rgEvent(type: string, line = 1, contents = "needle", file = "./match.txt") {
	return JSON.stringify({ type, data: { path: { text: file }, lines: { text: contents + "\n" }, line_number: line } }) + "\n";
}

function text(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("native names and schemas, lazy construction and remote-only ls", async () => {
	const f = await fixture();
	try {
		const natives = [createGrepTool(f.local), createFindTool(f.local), createLsTool(f.local)];
		assert.deepEqual(f.commands, []);
		f.tools.forEach((tool, i) => {
			assert.equal(tool.name, natives[i].name);
			assert.deepEqual(tool.parameters, natives[i].parameters);
			assert.match(tool.description, /SSH only/);
		});
		await mkdir(join(f.project, "directory"));
		await writeFile(join(f.project, ".hidden"), "");
		await writeFile(join(f.project, "alpha"), "");
		await writeFile(join(f.project, "Zulu"), "");
		const ls = f.tools[2];
		assert.equal(text(await ls.execute("ls", {})), ".hidden\nalpha\ndirectory/\nZulu");
		assert.equal(f.commands.length, 1);
		const limited = await ls.execute("ls", { limit: 2 });
		assert.match(text(limited), /^.hidden\nalpha\n/);
		assert.equal(limited.details.entryLimitReached, 2);
		assert.doesNotMatch(text(limited), /LOCAL_ONLY/);
		// The parent can suffix names without changing execution.
		const renamed = { ...ls, name: "ls-ssh" };
		assert.equal(text(await renamed.execute("renamed", { path: "directory" })), "(empty directory)");
		await assert.rejects(ls.execute("ls", { path: "alpha" }), /Not a directory/);
		await assert.rejects(ls.execute("ls", { path: "missing" }), /No such file/);
	} finally { await f.cleanup(); }
});

test("remote cwd is read at execution time; relative, absolute, @ and remote home paths", async () => {
	const f = await fixture();
	try {
		const other = join(f.root, "other");
		await mkdir(other);
		await writeFile(join(other, "OTHER"), "");
		await writeFile(join(f.home, "HOME_ONLY"), "");
		const ls = f.tools[2];
		assert.equal(text(await ls.execute("ls", { path: `@${other}` })), "OTHER");
		assert.equal(text(await ls.execute("ls", { path: "~" })), "HOME_ONLY");
		assert.equal(text(await ls.execute("ls", { path: "~/../other" })), "OTHER");
		f.remote.remoteCwd = other;
		assert.equal(text(await ls.execute("ls", {})), "OTHER");
	} finally { await f.cleanup(); }
});

test("grep regex, literal, ignoreCase, globs, context, ignore files and global match limit", { skip: !hasRg }, async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.project, ".git"));
		await writeFile(join(f.project, ".gitignore"), "ignored.txt\n");
		await writeFile(join(f.project, "ignored.txt"), "needle");
		await writeFile(join(f.project, "a.ts"), "before\nNeedle.*\nafter\n");
		await writeFile(join(f.project, "b.ts"), "Needle.*\nNeedle.*\n");
		await writeFile(join(f.project, ".hidden.ts"), "hidden needle\n");
		const grep = f.tools[0];
		const result = await grep.execute("grep", { pattern: "needle\\.\\*", ignoreCase: true, glob: "a.ts", context: 1 });
		assert.equal(text(result), "a.ts-1- before\na.ts:2: Needle.*\na.ts-3- after");
		const literal = text(await grep.execute("grep", { pattern: "Needle.*", literal: true, glob: "*.ts" }));
		assert.match(literal, /a.ts:2: Needle\.\*/);
		assert.match(literal, /b.ts:1: Needle\.\*/);
		const limited = await grep.execute("grep", { pattern: "Needle", limit: 1 });
		assert.equal(limited.details.matchLimitReached, 1);
		assert.equal(text(limited).split("\n").filter((s) => /\.ts:\d+:/.test(s)).length, 1);
		const all = text(await grep.execute("grep", { pattern: "needle", ignoreCase: true }));
		assert.match(all, /\.hidden.ts:1:/);
		assert.doesNotMatch(all, /ignored.txt/);
		assert.equal(text(await grep.execute("grep", { pattern: "absent" })), "No matches found");
		assert.match(text(await grep.execute("grep", { pattern: "Needle", path: "a.ts" })), /^a.ts:2:/);
		await assert.rejects(grep.execute("grep", { pattern: "[" }), /regex parse error/);
		await assert.rejects(grep.execute("grep", { pattern: "x", path: "missing" }), /No such file/);
	} finally { await f.cleanup(); }
});

test("find globs, path globs, hidden files, ignore rules, limits and no matches", { skip: !hasFd }, async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.project, "src"));
		await writeFile(join(f.project, ".gitignore"), "ignored.ts\n");
		await writeFile(join(f.project, "ignored.ts"), "");
		await writeFile(join(f.project, "src", "one.spec.ts"), "");
		await writeFile(join(f.project, "src", "two.ts"), "");
		await writeFile(join(f.project, ".hidden.ts"), "");
		const find = f.tools[1];
		const output = text(await find.execute("find", { pattern: "*.ts" }));
		assert.match(output, /src\/two.ts/);
		assert.match(output, /\.hidden.ts/);
		assert.doesNotMatch(output, /ignored.ts/);
		assert.equal(text(await find.execute("find", { pattern: "src/**/*.spec.ts" })), "src/one.spec.ts");
		const limited = await find.execute("find", { pattern: "*.ts", limit: 1 });
		assert.equal(limited.details.resultLimitReached, 1);
		assert.equal(text(limited).split("\n\n")[0].split("\n").length, 1);
		assert.equal(text(await find.execute("find", { pattern: "*.absent" })), "No files found matching pattern");
		await assert.rejects(find.execute("find", { pattern: "*", path: "missing" }), /No such file/);
	} finally { await f.cleanup(); }
});

test("shell metacharacters, option-like patterns and NUL validation", { skip: !hasRg || !hasFd }, async () => {
	const f = await fixture();
	try {
		const directory = "odd ' ; touch INJECTED; #\n$(touch INJECTED)";
		const pattern = "-needle'; touch INJECTED; # $(touch INJECTED)";
		const glob = "*'; touch INJECTED; #*";
		await mkdir(join(f.project, directory));
		await writeFile(join(f.project, directory, "match.txt"), pattern);
		const [grep, find, ls] = f.tools;
		assert.equal(text(await ls.execute("ls", { path: directory })), "match.txt");
		assert.match(text(await grep.execute("grep", { path: directory, pattern, literal: true })), /match.txt:1:/);
		assert.equal(text(await grep.execute("grep", { pattern, literal: true, glob })), "No matches found");
		assert.equal(text(await find.execute("find", { pattern: glob })), "No files found matching pattern");
		assert.equal(text(await find.execute("find", { pattern: "*.txt", path: directory })), "match.txt");
		assert.equal((await readdir(f.project)).includes("INJECTED"), false);
		await assert.rejects(access(join(f.project, "INJECTED")));
		const count = f.commands.length;
		await assert.rejects(grep.execute("grep", { pattern: "x\0y" }), /NUL/);
		await assert.rejects(ls.execute("ls", { path: "x\0y" }), /NUL/);
		for (const limit of [-1, 1.5, Infinity]) await assert.rejects(ls.execute("ls", { limit }), /integer/);
		assert.equal(f.commands.length, count);
	} finally { await f.cleanup(); }
});

test("large output is truncated in memory, and long grep lines are marked", { skip: !hasRg }, async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.project, "long.txt"), "needle " + "x".repeat(2000));
		const long = await f.tools[0].execute("grep", { pattern: "needle" });
		assert.equal(long.details.linesTruncated, true);
		await writeFile(join(f.project, "long.txt"), Array.from({ length: 300 }, () => "needle " + "x".repeat(300)).join("\n"));
		const result = await f.tools[0].execute("grep", { pattern: "needle", limit: 1000 });
		assert.equal(result.details.truncation.truncated, true);
		assert.equal(result.details.fullOutputPath, undefined);
		assert.ok(Buffer.byteLength(text(result)) < 52 * 1024);
	} finally { await f.cleanup(); }
});

test("SSH errors fail closed, abort is forwarded, and every call has a timeout", async () => {
	const f = await fixture();
	try {
		const [grep, find, ls] = f.tools;
		f.remote.execChannel = async () => { throw new Error("SSH unavailable"); };
		await assert.rejects(ls.execute("ls", {}), /SSH unavailable/);
		await assert.rejects(find.execute("find", { pattern: "*" }), /SSH unavailable/);
		await assert.rejects(grep.execute("grep", { pattern: "local secret" }), /SSH unavailable/);
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await assert.rejects(ls.execute("ls", {}, alreadyAborted.signal), /aborted/i);

		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		f.remote.execChannel = async () => {
			const channel = new EventEmitter();
			Object.assign(channel, { stderr: new PassThrough(), close() {
				closed = true;
				queueMicrotask(() => channel.emit("close"));
			} });
			return channel as ClientChannel;
		};
		const controller = new AbortController();
		const pending = ls.execute("ls", {}, controller.signal);
		timer = setTimeout(() => controller.abort(), 10);
		await assert.rejects(pending, /aborted/i);
		clearTimeout(timer);
		assert.equal(closed, true);
		// Trigger the remote timeout immediately, without waiting a minute.
		const original = globalThis.setTimeout;
		let timeout: number | undefined;
		try {
			globalThis.setTimeout = ((callback: () => void, ms?: number) => {
				if (ms === 60_000) timeout = ms;
				return original(callback, ms === 60_000 ? 1 : ms);
			}) as typeof setTimeout;
			await assert.rejects(ls.execute("ls", {}), /timeout:60/);
		} finally { globalThis.setTimeout = original; }
		assert.equal(timeout, 60_000);
	} finally { await f.cleanup(); }
});

test("stderr never enters JSON or filename parsers, including split UTF-8", async () => {
	for (const index of [0, 1, 2] as const) {
		const stdout = Buffer.from(index === 0 ? rgEvent("match", 1, "needle €") : "entry-€.txt\0");
		const split = stdout.indexOf(Buffer.from("€")) + 1;
		const warning = Buffer.from("warning: € remote diagnostic\n");
		const warningSplit = warning.indexOf(Buffer.from("€")) + 1;
		const f = scriptedRemote((channel) => {
			channel.emit("data", stdout.subarray(0, split));
			channel.stderr.emit("data", warning.subarray(0, warningSplit));
			channel.emit("data", stdout.subarray(split));
			channel.stderr.emit("data", warning.subarray(warningSplit));
			channel.emit("exit", 0);
			channel.emit("close", 0);
		});
		const result = index === 0 ? await f.tools[0].execute("grep", { pattern: "needle" })
			: index === 1 ? await f.tools[1].execute("find", { pattern: "*.txt" })
			: await f.tools[2].execute("ls", {});
		assert.equal(text(result), index === 0 ? "match.txt:1: needle €" : "entry-€.txt");
		assert.equal(f.state.closes, 0);
	}
	const failed = scriptedRemote((channel) => {
		channel.stderr.emit("data", Buffer.from("permission denied\n"));
		channel.emit("exit", 2);
		channel.emit("close", 2);
	});
	await assert.rejects(failed.tools[0].execute("grep", { pattern: "x" }), /permission denied.*\nCommand exited with code 2/);
});

test("ls retains only the sorted top-k entries from a large directory stream", async () => {
	const limit = 4;
	const f = scriptedRemote((channel) => {
		for (let i = 19_999; i >= 0; i--) {
			channel.emit("data", Buffer.from(`entry-${String(i).padStart(5, "0")}\0`));
		}
		channel.emit("exit", 0);
		channel.emit("close", 0);
	});
	// Observe arrays of directory names rather than relying on flaky heap-size
	// measurements. The original collect-everything implementation fails this.
	let retained = 0;
	const measure = (array: unknown[]) => {
		if (typeof array[0] === "string" && array[0].startsWith("entry-")) retained = Math.max(retained, array.length);
	};
	const push = Array.prototype.push;
	const splice = Array.prototype.splice;
	try {
		Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
			const result = Reflect.apply(push, this, items);
			measure(this);
			return result;
		};
		Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
			const result = Reflect.apply(splice, this, args);
			measure(this);
			return result;
		} as typeof splice;
		const result = await f.tools[2].execute("ls", { limit });
		assert.equal(text(result).split("\n\n")[0], "entry-00000\nentry-00001\nentry-00002\nentry-00003");
		assert.equal(result.details.entryLimitReached, limit);
		assert.equal(retained, limit);
	} finally {
		Array.prototype.push = push;
		Array.prototype.splice = splice;
	}
});

test("grep stops an unfinished command at the limit without parsing later records", async () => {
	const f = scriptedRemote((channel) => {
		channel.emit("data", Buffer.from(rgEvent("match") + "not JSON and must never be parsed\n"));
		// No EOF or exit status until the client deliberately closes the channel.
	});
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), 1000);
	try {
		const result = await f.tools[0].execute("grep", { pattern: "needle", limit: 1 }, controller.signal);
		assert.equal(text(result).split("\n\n")[0], "match.txt:1: needle");
		assert.equal(result.details.matchLimitReached, 1);
		assert.equal(f.state.closes, 1);
		assert.equal(f.state.invalidations, 0);
	} finally { clearTimeout(watchdog); }
});

test("grep waits for trailing context, treats further matches as context, and stops at EOF", async () => {
	for (const eof of [false, true]) {
		let closedBeforeContext = false;
		const f = scriptedRemote((channel) => {
			channel.emit("data", Buffer.from(rgEvent("context", 1, "before") + rgEvent("match", 2)));
			closedBeforeContext = f.state.closes !== 0;
			channel.emit("data", Buffer.from(rgEvent("match", 3, "needle again")));
			if (eof) channel.emit("data", Buffer.from(rgEvent("end")));
			else channel.emit("data", Buffer.from(rgEvent("context", 4, "after") + "must not parse\n"));
		});
		const controller = new AbortController();
		const watchdog = setTimeout(() => controller.abort(), 1000);
		try {
			const result = await f.tools[0].execute("grep", { pattern: "needle", limit: 1, context: 2 }, controller.signal);
			const expected = "match.txt-1- before\nmatch.txt:2: needle\nmatch.txt-3- needle again";
			assert.equal(text(result).split("\n\n")[0], expected + (eof ? "" : "\nmatch.txt-4- after"));
			assert.equal(closedBeforeContext, false);
			assert.equal(f.state.closes, 1);
		} finally { clearTimeout(watchdog); }
	}
});

test("user cancellation wins over a simultaneous deliberate grep stop", async () => {
	const controller = new AbortController();
	const f = scriptedRemote((channel) => {
		const close = channel.close.bind(channel);
		channel.close = () => { controller.abort(); return close(); };
		channel.emit("data", Buffer.from(rgEvent("match")));
	});
	await assert.rejects(f.tools[0].execute("grep", { pattern: "needle", limit: 1 }, controller.signal), /aborted/i);
	assert.equal(f.state.closes, 1);
});

test("a dropped channel is not mistaken for a successful search", async () => {
	const f = scriptedRemote((channel) => channel.emit("close"));
	await assert.rejects(f.tools[2].execute("ls", {}), /SSH connection.*dropped/);
});
