import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./test-server.ts";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

test("real Pi RPC starts with a single-target file and no UI replies", { timeout: 30_000 }, async (t) => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(path.resolve("tmp/rpc-startup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const remote = path.join(root, "remote");
	const home = path.join(root, "home");
	await mkdir(remote);
	await mkdir(home);
	const key = path.join(root, "hostkey");
	execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"], { timeout: 5000 });
	const server = await startServer({ port: 0, hostKeyPath: key, sandbox: remote });
	t.after(() => { server.dropConnections(); server.close(); });
	const file = path.join(root, "connection.json");
	const raw = JSON.stringify({ rpc: {
		host: "127.0.0.1", port: server.port, user: "test", password: "testpass",
		projects: [{ title: "RPC", path: remote }],
	} });
	await writeFile(file, raw);
	const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent") };
	delete env.PI_CODING_AGENT_SSH_REMOTE_PROJECT;
	delete env.PI_CODING_AGENT_SSH_REMOTE_CONFIG;
	const child = spawn(process.execPath, [
		path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
		"--no-extensions", "-e", path.resolve("src/index.ts"), "--no-mcp", "--no-skills",
		"--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "--no-session",
		"--mode", "rpc", "--ssh-remote-config", file,
	], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill("SIGKILL"));
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
	const messages: unknown[] = [];
	await new Promise<void>((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`RPC startup timed out: ${stderr}`)), 20_000);
		const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
		child.once("error", finish);
		child.once("exit", (code) => finish(new Error(`Pi exited ${code}: ${stderr}`)));
		child.stdout.setEncoding("utf8").on("data", (data: string) => {
			buffer += data;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const event: unknown = JSON.parse(line);
					messages.push(event);
					if (record(event) && event.id === "messages") finish();
				} catch (error) { finish(new Error(`Invalid RPC output: ${line}`, { cause: error })); }
			}
		});
		child.stdin.write(JSON.stringify({ id: "messages", type: "get_messages" }) + "\n");
	});
	assert.ok(!messages.filter(record).some((event) => event.type === "extension_ui_request" && ["select", "input", "confirm"].includes(String(event.method))), JSON.stringify(messages));
	assert.ok(JSON.stringify(messages).includes(`SSH connected to: rpc, CWD: ${remote}`), JSON.stringify(messages));
	assert.equal(await readFile(file, "utf8"), raw);
	await assert.rejects(readFile(path.join(home, ".pi", "agent", "ssh-remote-config.json")), { code: "ENOENT" });
});
