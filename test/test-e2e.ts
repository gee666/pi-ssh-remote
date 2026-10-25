import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./test-server.ts";

const piBin = process.env.EVERGREEN_PI_BIN || "pi";
const model = process.env.EVERGREEN_E2E_MODEL;
const extension = path.resolve("src/index.ts");

function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(piBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
		child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
		child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || !stdout.includes('"type":"agent_start"')) reject(new Error(`Pi exited ${code}\n${stderr}\n${stdout}`));
			else resolve(stdout);
		});
	});
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// Real CLI + real model + real SSH, with no user config or project resources loaded.
test("installed Pi works on the remote project, not its local launch directory", { timeout: 400_000 }, async (t) => {
	assert.ok(model, "Set EVERGREEN_E2E_MODEL to an authenticated provider/model (optional :thinking)");
	const root = await mkdtemp(path.join(tmpdir(), "ssh-evergreen-e2e-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const local = path.join(root, "local");
	const remote = path.join(root, "remote");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(local), mkdir(remote)]);
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	// Copy only provider credentials/catalog; never discover the user's extensions/settings.
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		await copyFile(path.join(originalAgentDir, file), path.join(agentDir, file)).catch((error: unknown) => {
			if (!record(error) || error.code !== "ENOENT") throw error;
		});
	}
	const key = path.join(root, "hostkey");
	execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"], { stdio: "ignore" });
	const server = await startServer({ port: 0, hostKeyPath: key, sandbox: remote });
	try {
		await writeFile(path.join(agentDir, "ssh-remote-config.json"), JSON.stringify({ evergreen: {
			host: "127.0.0.1", port: server.port, user: "test", password: "testpass",
			projects: [{ title: "Evergreen", path: remote }],
		} }));
		for (const mode of ["ssh", "ssh-local-first"]) {
			const nonce = randomUUID();
			await writeFile(path.join(remote, "source.txt"), `${nonce} ALPHA\n`);
			await writeFile(path.join(local, "source.txt"), "LOCAL_DECOY ALPHA\n");
			const suffix = mode === "ssh" ? "" : "-ssh";
			const output = await runPi([
				"--no-extensions", "--extension", extension, "--no-mcp", "--no-skills",
				"--no-prompt-templates", "--no-themes", "--no-context-files", "--offline",
				"--session-dir", path.join(root, "sessions"), "--mode", "json", "--print", "--model", model,
				...(mode === "ssh" ? [] : ["--ssh-local-first"]), "--",
				`On the SSH project, perform these steps using exactly these tools: ` +
				`read${suffix} source.txt; write${suffix} result.txt with exactly its contents; ` +
				`edit${suffix} result.txt replacing ALPHA with BETA; ` +
				`bash${suffix} command 'cp result.txt verified.txt'. Use relative paths. Then stop.`,
			], local, {
				...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SSH_REMOTE_PROJECT: `evergreen::${remote}`,
			});
			const events: unknown[] = output.trim().split("\n").map((line) => JSON.parse(line));
			const starts = events.filter(record).filter((event) => event.type === "tool_execution_start");
			for (const name of ["read", "write", "edit", "bash"]) {
				assert.ok(starts.some((event) => event.toolName === name + suffix), `${mode}: missing ${name}${suffix}\n${output}`);
			}
			assert.ok(!events.filter(record).some((event) => event.type === "tool_execution_end" && event.isError), output);
			assert.equal((await readFile(path.join(remote, "result.txt"), "utf8")).trimEnd(), `${nonce} BETA`);
			assert.equal(await readFile(path.join(remote, "verified.txt"), "utf8"), await readFile(path.join(remote, "result.txt"), "utf8"));
			assert.equal(await readFile(path.join(local, "source.txt"), "utf8"), "LOCAL_DECOY ALPHA\n");
			for (const file of ["result.txt", "verified.txt"]) {
				await assert.rejects(readFile(path.join(local, file)), { code: "ENOENT" });
				await rm(path.join(remote, file));
			}
		}
	} finally {
		server.dropConnections();
		server.close();
	}
});
