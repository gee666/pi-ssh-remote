import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "./test-server.ts";

function text(result: { content: readonly ({ type: "text"; text: string } | { type: "image" })[] }): string {
	return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

test("public Pi tools complete a remote file workflow without touching the local project", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-ssh-tool-workflow-"));
	const oldHome = process.env.HOME;
	process.env.HOME = root;
	try {
		// Config paths are captured from homedir() at import time, including known-host pins.
		const { createReadTool, createWriteTool, createEditTool, createBashTool } = await import("@earendil-works/pi-coding-agent");
		const { RemoteConnection } = await import("../src/connection.ts");
		const { RemoteFsRouter } = await import("../src/remote-fs.ts");
		const { createRemoteReadOps, createRemoteWriteOps, createRemoteEditOps, createRemoteBashOps } = await import("../src/operations.ts");
		const { withLocalSkillReads } = await import("../src/skill-read.ts");
		const { CONFIG_PATH, KNOWN_HOSTS_PATH } = await import("../src/config.ts");
		assert.equal(CONFIG_PATH, path.join(root, ".pi/agent/ssh-remote-config.json"));
		assert.equal(KNOWN_HOSTS_PATH, path.join(root, ".pi/agent/ssh-remote-known-hosts.json"));

		const key = path.join(root, "hostkey");
		execFileSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", "", "-q"], { timeout: 5000 });
		for (const disableSftp of [false, true]) {
			await t.test(disableSftp ? "shell fallback" : "SFTP", async () => {
				const modeRoot = path.join(root, disableSftp ? "shell" : "sftp");
				const localCwd = path.join(modeRoot, "local project");
				const remoteHome = path.join(modeRoot, "remote home");
				const remoteCwd = path.join(remoteHome, "remote project");
				const output = "generated/report.txt";
				await mkdir(path.join(localCwd, "generated"), { recursive: true });
				await mkdir(remoteCwd, { recursive: true });
				await writeFile(path.join(localCwd, "input.txt"), "LOCAL INPUT\n");
				await writeFile(path.join(localCwd, output), "LOCAL REPORT\n");
				await writeFile(path.join(remoteCwd, "input.txt"), "REMOTE INPUT\n");
				const skill = path.join(localCwd, "skills/workflow/SKILL.md");
				await mkdir(path.dirname(skill), { recursive: true });
				await writeFile(skill, "LOCAL ADVERTISED SKILL\n");

				const server = await startServer({ port: 0, hostKeyPath: key, sandbox: remoteHome, disableSftp });
				const remote = new RemoteConnection({
					serverName: "workflow",
					server: { host: "127.0.0.1", port: server.port, user: "test", password: "testpass" },
					project: { title: "Workflow", path: "remote project" },
					label: "Workflow",
				});
				try {
					const fs = new RemoteFsRouter(remote);
					let fellBack = false;
					fs.onFallback = () => { fellBack = true; };
					const cwd = await fs.resolveProjectCwd();
					assert.equal(cwd, remoteCwd);
					assert.notEqual(cwd, localCwd);
					// Match extension wiring: file tools resolve against the remote project.
					const read = withLocalSkillReads(createReadTool(cwd, { operations: createRemoteReadOps(fs) }), localCwd, () => [skill]);
					const write = createWriteTool(cwd, { operations: createRemoteWriteOps(fs) });
					const edit = createEditTool(cwd, { operations: createRemoteEditOps(fs) });
					const bash = createBashTool(cwd, { operations: createRemoteBashOps(remote, localCwd) });

					assert.equal(text(await read.execute("input", { path: "input.txt" })), "REMOTE INPUT\n");
					await write.execute("write", { path: output, content: "Source: REMOTE INPUT\nStatus: draft\n" });
					assert.equal(await readFile(path.join(remoteCwd, output), "utf8"), "Source: REMOTE INPUT\nStatus: draft\n");
					await edit.execute("edit", { path: output, edits: [{ oldText: "Status: draft", newText: "Status: ready" }] });
					const edited = "Source: REMOTE INPUT\nStatus: ready\n";
					assert.equal(text(await read.execute("edited", { path: output })), edited);
					assert.equal(await readFile(path.join(remoteCwd, output), "utf8"), edited);

					const result = await bash.execute("verify", {
						command: "pwd && cat generated/report.txt && printf 'Verified by bash\\n' >> generated/report.txt",
					});
					assert.equal(text(result), `${remoteCwd}\n${edited}`);
					assert.equal(text(await read.execute("verified", { path: output })), `${edited}Verified by bash\n`);

					// Only advertised skill files bypass SSH; ordinary relative reads above do not.
					assert.equal(text(await read.execute("skill", { path: skill })), "LOCAL ADVERTISED SKILL\n");
					assert.equal(await readFile(path.join(localCwd, "input.txt"), "utf8"), "LOCAL INPUT\n");
					assert.equal(await readFile(path.join(localCwd, output), "utf8"), "LOCAL REPORT\n");
					assert.equal(fellBack, disableSftp);
				} finally {
					remote.dispose();
					server.dropConnections();
					server.close();
				}
			});
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		await rm(root, { recursive: true, force: true });
	}
});
