import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { withLocalSkillReads } from "../src/skill-read.ts";

test("skill reads prefer local files; ordinary and absent files stay remote", async () => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(resolve("tmp/skill-read-"));
	try {
		const skill = join(root, "custom-package", "SKILL.md");
		const reference = join(root, "custom-package", "references", "guide.md");
		const standalone = join(root, "standalone.md");
		await mkdir(join(root, "custom-package", "references"), { recursive: true });
		await writeFile(skill, "local skill\nsecond line\nthird line");
		await writeFile(reference, "local reference");
		await writeFile(standalone, "standalone skill");
		await writeFile(join(root, "normal.txt"), "must not read locally");
		const calls: string[] = [];
		const remote = createReadTool("/remote", { operations: {
			access: async () => {},
			readFile: async (path) => { calls.push(path); return Buffer.from("remote"); },
		} });
		let skills = [skill, standalone];
		const tool = withLocalSkillReads(remote, root, () => skills);
		const read = async (path: string, offset?: number, limit?: number) => {
			const result = await tool.execute("test", { path, offset, limit });
			return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		};
		assert.match(await read(skill), /local skill/);
		assert.match(await read(`@${skill}`, 2, 1), /^second line/);
		assert.match(await read("custom-package/SKILL.md"), /local skill/);
		assert.equal(await read(reference), "local reference");
		assert.equal(await read(standalone), "standalone skill");
		assert.deepEqual(calls, []);
		assert.equal(await read(join(root, "normal.txt")), "remote");
		assert.equal(await read("normal.txt"), "remote");
		assert.equal(calls.at(-1), "/remote/normal.txt");
		assert.equal(await read(join(root, "custom-package", "..", "normal.txt")), "remote");
		assert.equal(await read(join(root, "custom-package-extra", "guide.md")), "remote");
		await rm(skill);
		assert.equal(await read(skill), "remote");
		assert.equal(calls.at(-1), skill);
		skills = [];
		assert.equal(await read(reference), "remote");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("local skills remain readable when SSH setup fails", async () => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(resolve("tmp/skill-failure-"));
	try {
		const skill = join(root, "SKILL.md");
		await writeFile(skill, "offline skill");
		const refuse = async () => { throw new Error("SSH unavailable"); };
		const tool = withLocalSkillReads(createReadTool("/remote", {
			operations: { readFile: refuse, access: refuse },
		}), root, () => [skill]);
		const result = await tool.execute("test", { path: skill });
		assert.deepEqual(result.content, [{ type: "text", text: "offline skill" }]);
		await assert.rejects(tool.execute("test", { path: "/ordinary/file" }), /SSH unavailable/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
