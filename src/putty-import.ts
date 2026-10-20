import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.ts";

/** Stock dialogs work in both terminal and RPC clients. Nothing is saved on Escape. */
export async function choosePuttyConnections(
	ctx: ExtensionContext,
	connections: Record<string, ServerConfig>,
): Promise<Record<string, ServerConfig> | undefined> {
	if (!ctx.hasUI) throw new Error("PuTTY import requires an interactive session.");
	const names = Object.keys(connections).sort();
	if (!names.length) return undefined;
	const all = `Import all (${names.length})`;
	const action = await ctx.ui.select("Import PuTTY connections, existing names will be updated", [all, "Choose connections"]);
	if (action === undefined) return undefined;
	if (action === all) return connections;
	if (action !== "Choose connections") return undefined;

	const selected = new Set<string>();
	for (;;) {
		const commit = `Import selected (${selected.size})`;
		const labels = names.map((name, index) => `${selected.has(name) ? "[x]" : "[ ]"} ${index + 1}. ${name}`);
		const choice = await ctx.ui.select("Toggle connections, then choose Import selected", [commit, "Select all", "Clear selection", ...labels]);
		if (choice === undefined) return undefined;
		if (choice === commit) {
			if (!selected.size) { ctx.ui.notify("Select at least one connection, or press Escape to cancel.", "warning"); continue; }
			return Object.fromEntries(names.filter((name) => selected.has(name)).map((name) => [name, connections[name]]));
		}
		if (choice === "Select all") { for (const name of names) selected.add(name); continue; }
		if (choice === "Clear selection") { selected.clear(); continue; }
		const index = labels.indexOf(choice);
		if (index < 0) continue;
		const name = names[index];
		if (selected.has(name)) selected.delete(name);
		else selected.add(name);
	}
}
