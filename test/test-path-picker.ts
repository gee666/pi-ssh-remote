import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { ClientChannel } from "ssh2";
import type { RemoteConnection } from "../src/connection.ts";
import { chooseRemotePath } from "../src/path-picker.ts";

await mkdir("tmp", { recursive: true });
const root = await mkdtemp(path.resolve("tmp/path-picker-"));
const home = path.join(root, "home ' with spaces");
await mkdir(home);
for (const dir of [".hidden", "alpha one", "alpha two", "single dir", "quote '$(touch INJECTED); *?[]", "nested", "🦊 one", "🦊 two"]) {
	await mkdir(path.join(home, dir));
}
await mkdir(path.join(home, "nested", "child dir"));
await mkdir(path.join(home, "control\x1bname"));
await writeFile(path.join(home, "plain-file"), "not a directory");
await symlink(path.join(home, "nested"), path.join(home, "dir-link"));
await symlink(path.join(home, "plain-file"), path.join(home, "file-link"));
after(() => rm(root, { recursive: true, force: true }));

interface Screen {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

function shellRemote() {
	const channels: Array<{ closed: number; command: string }> = [];
	return {
		remote: {
			remoteCwd: home,
			async execChannel(command: string) {
				const child = spawn("bash", ["-c", command], { cwd: home, env: { ...process.env, HOME: home } });
				const record = { closed: 0, command };
				channels.push(record);
				const stream = Object.assign(new EventEmitter(), {
					stderr: child.stderr,
					end() { child.stdin.end(); },
					close() { record.closed++; child.kill(); },
				});
				child.stdout.on("data", (data) => stream.emit("data", data));
				child.on("close", (code) => stream.emit("close", code));
				child.on("error", (error) => stream.emit("error", error));
				return stream as unknown as ClientChannel;
			},
		} as unknown as RemoteConnection,
		channels,
	};
}

function harness(remote: RemoteConnection, options: {
	initial?: string;
	mode?: string;
	hasUI?: boolean;
	input?: string;
	custom?: "missing" | "noop" | "reject";
	signal?: AbortSignal;
} = {}) {
	let screen: Screen | undefined;
	let renderCount = 0;
	let inputCount = 0;
	let customCount = 0;
	let fallbackTitle = "";
	const ui = {
		async input(title: string) { inputCount++; fallbackTitle = title; return options.input; },
		custom: options.custom === "missing" ? undefined : (factory: Function) => {
			customCount++;
			if (options.custom === "noop") return Promise.resolve(undefined);
			if (options.custom === "reject") return Promise.reject(new Error("custom UI is unsupported"));
			return new Promise((done) => {
				screen = factory({ requestRender() { renderCount++; } }, {
					fg: (_color: string, text: string) => text,
				}, getKeybindings(), done);
				screen!.focused = true;
			});
		},
	};
	const ctx = { hasUI: options.hasUI ?? true, mode: options.mode, ui, signal: options.signal } as unknown as ExtensionContext;
	const result = chooseRemotePath(ctx, remote, options.initial);
	return {
		result,
		screen: () => { assert.ok(screen); return screen; },
		text: () => screen!.render(120).join("\n"),
		key: (data: string) => { assert.ok(screen); screen.handleInput(data); },
		renders: () => renderCount,
		inputs: () => inputCount,
		customs: () => customCount,
		title: () => fallbackTitle,
	};
}

async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function ready(h: ReturnType<typeof harness>) {
	await waitFor(() => !h.text().includes("Loading directories..."));
}

test("unconnected home probe opens immediately and accepts input while SSH is pending", async () => {
	let requested = false;
	const remote = {
		remoteCwd: ".",
		execChannel: () => { requested = true; return new Promise(() => {}); },
	} as unknown as RemoteConnection;
	const h = harness(remote, { mode: "tui" });
	assert.equal(h.customs(), 1);
	assert.match(h.text(), /Loading directories/);
	await waitFor(() => requested);
	h.key("new folder");
	h.key("\r");
	assert.equal(await h.result, "./new folder");
});

test("unresolved home hints load in the background without SFTP preflight", async () => {
	const { remote } = shellRemote();
	remote.remoteCwd = ".";
	const h = harness(remote, { mode: "tui", initial: "sing" });
	try {
		assert.equal(h.customs(), 1);
		await ready(h);
		assert.match(h.text(), /single dir\//);
		h.key("\t");
		h.key("\r");
		assert.equal(await h.result, "./single dir/");
	} finally { h.key("\x1b"); }
});

test("RPC falls back to input, expands home, and never lists directories", async () => {
	const { remote, channels } = shellRemote();
	for (const [input, expected] of [["", home], ["~", home], ["~/nested", `${home}/nested`], ["relative space ", `${home}/relative space `], ["/absolute", "/absolute"], ["link/../x", `${home}/link/../x`]] as const) {
		const h = harness(remote, { mode: "rpc", input });
		assert.equal(await h.result, expected);
		assert.equal(h.inputs(), 1);
		assert.equal(h.customs(), 0);
		assert.match(h.title(), /empty = remote home/);
	}
	assert.equal(channels.length, 0);
});

test("cancellation, unavailable UI, and missing custom API", async () => {
	const { remote } = shellRemote();
	assert.equal(await harness(remote, { mode: "rpc" }).result, undefined);
	for (const mode of ["print", "json"]) {
		const h = harness(remote, { mode, hasUI: false });
		assert.equal(await h.result, undefined);
		assert.equal(h.inputs(), 0);
	}
	const h = harness(remote, { mode: "tui", custom: "missing", input: "~" });
	assert.equal(await h.result, home);
});

test("legacy TUI without ctx.mode uses the picker; legacy RPC stubs fall back", async () => {
	const { remote } = shellRemote();
	const h = harness(remote);
	assert.equal(h.customs(), 1);
	h.key("\x1b");
	assert.equal(await h.result, undefined);
	assert.equal(h.inputs(), 0, "cancellation must not open a fallback dialog");
	for (const custom of ["noop", "reject"] as const) {
		const rpc = harness(remote, { custom, input: "~/nested" });
		assert.equal(await rpc.result, `${home}/nested`);
		assert.equal(rpc.inputs(), 1);
	}
});

test("directory-only hints preserve spaces, apostrophes, Unicode, and symlink directories", async () => {
	const { remote } = shellRemote();
	const h = harness(remote, { mode: "tui" });
	try {
		await ready(h);
		assert.match(h.text(), /\.hidden\//);
		assert.match(h.text(), /dir-link\//);
		assert.doesNotMatch(h.text(), /plain-file|file-link|control/);
		h.key("quote '");
		await ready(h);
		assert.match(h.text(), /quote '\$\(touch INJECTED\); \*\?\[\]\//);
		h.key("\t");
		h.key("\r");
		assert.equal(await h.result, `${home}/quote '$(touch INJECTED); *?[]/`);
		await assert.rejects(access(path.join(home, "INJECTED")));
	} finally { h.key("\x1b"); }
});

test("Tab extends the longest common prefix and requires a choice for ambiguity", async () => {
	const { remote } = shellRemote();
	const h = harness(remote, { mode: "tui", initial: "al" });
	try {
		await ready(h);
		h.key("\t");
		await ready(h);
		assert.match(h.text(), /alpha one\//);
		h.key("\t");
		assert.match(h.text(), /Multiple directories/);
		h.key("\x1b[B"); // Select the second hint.
		h.key("\t");
		h.key("\r");
		assert.equal(await h.result, `${home}/alpha two/`);
	} finally { h.key("\x1b"); }
});

test("initial absolute directory and ~/ prefixes complete children", async () => {
	const { remote } = shellRemote();
	for (const initial of [`${home}/nested/`, "~/nested/"]) {
		const h = harness(remote, { mode: "tui", initial });
		try {
			await ready(h);
			h.key("\t");
			h.key("\r");
			assert.equal(await h.result, `${home}/nested/child dir/`);
		} finally { h.key("\x1b"); }
	}
});

test("prefill cursor is at the end; Enter accepts typed input even if hints fail", async () => {
	const { remote } = shellRemote();
	const h = harness(remote, { mode: "tui", initial: "does not exist/" });
	try {
		h.key("child");
		await ready(h);
		assert.match(h.text(), /Cannot list this directory.*Tab retries/);
		h.key("\r");
		assert.equal(await h.result, `${home}/does not exist/child`);
	} finally { h.key("\x1b"); }
});

test("literal shell metacharacters cannot inject commands or broaden a glob prefix", async () => {
	const { remote } = shellRemote();
	for (const initial of ["$(touch INJECTED)", "`touch INJECTED`", "'; touch INJECTED; #", "*", "[a]", "?", "x/$(touch INJECTED)/"]) {
		const h = harness(remote, { mode: "tui", initial });
		try {
			await ready(h);
			assert.match(h.text(), /No matching directories|Cannot list this directory/);
			await assert.rejects(access(path.join(home, "INJECTED")));
		} finally { h.key("\x1b"); await h.result; }
	}
});

function deferredRemote() {
	const requests: Array<{ resolve: (channel: ClientChannel) => void; stream: EventEmitter & { stderr: EventEmitter; closed: number; close(): void; end(): void } }> = [];
	const remote = {
		remoteCwd: home,
		execChannel() {
			return new Promise<ClientChannel>((resolve) => {
				const stream = Object.assign(new EventEmitter(), {
					stderr: new EventEmitter(), closed: 0,
					close() { this.closed++; }, end() {},
				});
				requests.push({ resolve, stream });
			});
		},
	} as unknown as RemoteConnection;
	const open = async (index: number) => {
		const request = requests[index];
		request.resolve(request.stream as unknown as ClientChannel);
		await new Promise((resolve) => setImmediate(resolve));
		return request.stream;
	};
	return { remote, requests, open };
}

test("stale connection results cannot overwrite hints and late channels are closed", async () => {
	const { remote, requests, open } = deferredRemote();
	const h = harness(remote, { mode: "tui" });
	try {
		await waitFor(() => requests.length === 1);
		h.key("new");
		await waitFor(() => requests.length === 2);
		const second = await open(1);
		second.emit("data", Buffer.from("new dir\0"));
		second.emit("close", 0);
		await ready(h);
		assert.match(h.text(), /new dir\//);
		const first = await open(0);
		assert.equal(first.closed, 1);
		first.emit("data", Buffer.from("old dir\0"));
		first.emit("close", 0);
		assert.doesNotMatch(h.text(), /old dir/);
	} finally { h.key("\x1b"); await h.result; }
});

test("Escape closes active requests and suppresses later renders; disposal is idempotent", async () => {
	const { remote, requests, open } = deferredRemote();
	const h = harness(remote, { mode: "tui" });
	await waitFor(() => requests.length === 1);
	const stream = await open(0);
	h.key("\x1b");
	assert.equal(await h.result, undefined);
	const rendered = h.renders();
	h.screen().dispose();
	stream.emit("data", Buffer.from("late\0"));
	stream.emit("close", 0);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stream.closed, 1);
	assert.equal(h.renders(), rendered);
});

test("Tab during a pending fetch completes once; typing cancels deferred completion", async () => {
	const { remote, requests, open } = deferredRemote();
	const h = harness(remote, { mode: "tui", initial: "sin" });
	try {
		await waitFor(() => requests.length === 1);
		h.key("\t");
		const stream = await open(0);
		stream.emit("data", Buffer.from("single dir\0"));
		stream.emit("close", 0);
		await new Promise((resolve) => setImmediate(resolve));
		h.key("\r");
		assert.equal(await h.result, `${home}/single dir/`);
	} finally { h.key("\x1b"); }

	const other = deferredRemote();
	const typed = harness(other.remote, { mode: "tui" });
	try {
		await waitFor(() => other.requests.length === 1);
		typed.key("\t");
		typed.key("manual");
		const stale = await other.open(0);
		assert.equal(stale.closed, 1);
		typed.key("\r");
		assert.equal(await typed.result, `${home}/manual`);
	} finally { typed.key("\x1b"); }
});

test("errors stay editable and Tab retries; output is bounded", async () => {
	const { remote, requests, open } = deferredRemote();
	const h = harness(remote, { mode: "tui" });
	try {
		await waitFor(() => requests.length === 1);
		const failed = await open(0);
		failed.emit("close", 1);
		await ready(h);
		assert.match(h.text(), /Tab retries hints/);
		h.key("\t");
		await waitFor(() => requests.length === 2);
		const retry = await open(1);
		retry.emit("data", Buffer.alloc(1024 * 1024 + 1));
		await ready(h);
		assert.match(h.text(), /too large/);
		assert.equal(retry.closed, 1);
	} finally { h.key("\x1b"); await h.result; }
});

test("abort and cancel before debounce make no remote requests", async () => {
	const { remote, requests } = deferredRemote();
	const controller = new AbortController();
	const h = harness(remote, { mode: "tui", signal: controller.signal });
	controller.abort();
	assert.equal(await h.result, undefined);
	const other = harness(remote, { mode: "tui" });
	other.key("\x03");
	assert.equal(await other.result, undefined);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(requests.length, 0);
});

test("render lines fit narrow widths and focus reaches the built-in cursor", async () => {
	const { remote } = shellRemote();
	const h = harness(remote, { mode: "tui", initial: "🦊" });
	try {
		await ready(h);
		for (const width of [0, 1, 2, 3, 4, 10, 40, 100]) {
			h.screen().invalidate();
			for (const line of h.screen().render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
		}
		assert.match(h.text(), /\x1b_pi:c\x07/);
		h.screen().focused = false;
		assert.doesNotMatch(h.text(), /\x1b_pi:c\x07/);
	} finally { h.key("\x1b"); await h.result; }
});
