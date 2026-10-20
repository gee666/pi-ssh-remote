import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { choosePuttyConnections } from "../src/putty-import.ts";

const connections = { Beta: { host: "beta.example" }, Alpha: { host: "alpha.example" } };
function harness(answers: (string | undefined)[], hasUI = true) {
	const menus: string[][] = [];
	const warnings: string[] = [];
	const ctx = { hasUI, ui: {
		async select(_title: string, options: string[]) { menus.push(options); assert.ok(answers.length, "unexpected menu"); return answers.shift(); },
		notify(message: string) { warnings.push(message); },
	} } as unknown as ExtensionContext;
	return { ctx, menus, warnings };
}

test("import all preserves exact connection names and settings", async () => {
	const h = harness(["Import all (2)"]);
	assert.equal(await choosePuttyConnections(h.ctx, connections), connections);
	assert.equal(h.menus.length, 1);
});

test("choose individual connections with toggles", async () => {
	const h = harness(["Choose connections", "[ ] 1. Alpha", "[ ] 2. Beta", "[x] 1. Alpha", "Import selected (1)"]);
	assert.deepEqual(await choosePuttyConnections(h.ctx, connections), { Beta: connections.Beta });
	assert.deepEqual(h.menus[1].slice(3), ["[ ] 1. Alpha", "[ ] 2. Beta"]);
});

test("select all, clear, and prevent an empty import", async () => {
	const h = harness(["Choose connections", "Select all", "Clear selection", "Import selected (0)", "Select all", "Import selected (2)"]);
	assert.deepEqual(await choosePuttyConnections(h.ctx, connections), connections);
	assert.equal(h.warnings.length, 1);
});

test("Escape at either step cancels without importing anything", async () => {
	for (const answers of [[undefined], ["Choose connections", "[ ] 1. Alpha", undefined]]) {
		const h = harness(answers);
		assert.equal(await choosePuttyConnections(h.ctx, connections), undefined);
	}
});

test("no sessions skips dialogs and noninteractive import refuses", async () => {
	assert.equal(await choosePuttyConnections(harness([]).ctx, {}), undefined);
	await assert.rejects(choosePuttyConnections(harness([], false).ctx, connections), /interactive/);
});
