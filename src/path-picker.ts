import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { ClientChannel } from "ssh2";
import type { RemoteConnection } from "./connection.ts";

const REFRESH_DELAY_MS = 120;
const LIST_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Anchor at home without collapsing symlink/.. segments. '.' means unresolved home. */
function chosenPath(value: string, home: string): string {
	if (CONTROL.test(value)) throw new Error("Remote directory paths cannot contain control characters.");
	if (value.startsWith("/")) return value;
	if (value === "" || value === "~" || value === ".") return home;
	const relative = value.startsWith("~/") ? value.slice(2) : value;
	return `${home.replace(/\/$/, "")}/${relative}`;
}

/** List only directories, including directory symlinks. No parsing of ls output. */
async function directoryHints(remote: RemoteConnection, value: string, signal: AbortSignal): Promise<string[]> {
	const path = value === "~" ? "~/" : value;
	const slash = path.lastIndexOf("/");
	const parent = slash < 0 ? "." : path.slice(0, slash + 1);
	const prefix = path.slice(slash + 1);
	const base = slash < 0 ? "" : parent;
	const script = [
		'cd -- "$HOME" 2>/dev/null || exit 1',
		`p=${shellQuote(chosenPath(parent, remote.remoteCwd))}`,
		'CDPATH= cd -- "$p" 2>/dev/null || exit 1',
		`prefix=${shellQuote(prefix)}`,
		'for d in ./* ./.[!.]* ./..?*; do',
		'  [ -d "$d" ] || continue',
		'  name=${d#./}',
		'  case "$name" in "$prefix"*) printf \'%s\\0\' "$name";; esac',
		'done',
	].join("\n");

	const output = await new Promise<Buffer>((resolve, reject) => {
		let channel: ClientChannel | undefined;
		let settled = false;
		let size = 0;
		const chunks: Buffer[] = [];
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			// Do not close the shared RemoteConnection, only this listing's channel.
			try { channel?.close(); } catch { /* Already closed. */ }
			if (error) reject(error);
			else resolve(Buffer.concat(chunks));
		};
		const abort = () => finish(new Error("Directory listing cancelled."));
		const timer = setTimeout(() => finish(new Error("Directory listing timed out.")), LIST_TIMEOUT_MS);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { abort(); return; }

		// execChannel cannot abort connection establishment. Close a late channel too.
		remote.execChannel(`bash -c ${shellQuote(script)}`).then((stream) => {
			channel = stream;
			stream.on("error", () => finish(new Error("Directory listing failed.")));
			if (settled) {
				try { stream.close(); } catch { /* Already closed. */ }
				return;
			}
			stream.on("data", (data: Buffer | string) => {
				if (settled) return;
				const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
				size += chunk.length;
				if (size > MAX_OUTPUT_BYTES) finish(new Error("Directory listing is too large. Type a longer prefix."));
				else chunks.push(chunk);
			});
			// Drain stderr without displaying untrusted terminal escape sequences.
			stream.stderr.on("data", () => {});
			stream.on("close", (code: number | undefined) => {
				finish(code === 0 ? undefined : new Error("Cannot list this directory. Check the path and permissions."));
			});
			stream.end();
		}).catch(() => finish(new Error("Cannot fetch directories from the remote host.")));
	});

	return output.toString("utf8").split("\0")
		.filter((name) => name !== "" && name !== "." && name !== ".." && !CONTROL.test(name))
		.sort()
		.map((name) => `${base}${name}/`);
}

/**
 * Prompt for a remote directory. Escape/cancellation or a mode without UI returns undefined.
 * Pass a home probe connection, with remoteCwd set to '.' or the resolved absolute home.
 * Empty input, "." and "~" return that home; "~/foo" and "foo" return home + "/foo".
 * With an unresolved probe, returned relative paths are validated against home by the caller.
 * Absolute input is unchanged. Spaces and symlink/.. segments are preserved.
 * The caller validates the result. This picker does not resolve symlinks or check existence.
 * Hints contain directories only; names with terminal control characters are omitted.
 */
export async function chooseRemotePath(
	ctx: ExtensionContext,
	remote: RemoteConnection,
	initial = "",
): Promise<string | undefined> {
	if (!ctx.hasUI || ctx.signal?.aborted) return undefined;
	const home = remote.remoteCwd;
	if (home !== "." && !home.startsWith("/")) throw new Error("The remote path picker requires a home probe connection.");
	chosenPath(initial, home); // Reject unsafe terminal content before rendering a prefill.
	// The optional property also supports older Pi types that predate ctx.mode.
	const mode = (ctx as ExtensionContext & { mode?: string }).mode;
	const fallback = async () => {
		const value = await ctx.ui.input("Remote directory (empty = remote home; relative paths start at home)", initial || "~/", {
			signal: ctx.signal,
		});
		return value === undefined || ctx.signal?.aborted ? undefined : chosenPath(value, home);
	};
	if ((mode !== undefined && mode !== "tui") || typeof ctx.ui.custom !== "function") return fallback();

	let cleanup: (() => void) | undefined;
	let factoryCalled = false;
	try {
		const result = await ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
			factoryCalled = true;
			const input = new Input();
			function setInput(value: string) {
				// Bracketed paste places the cursor at the end without assuming a Ctrl+E binding.
				input.setValue("");
				input.handleInput(`\x1b[200~${value}\x1b[201~`);
			}
			setInput(initial);
			let disposed = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let request: AbortController | undefined;
			let generation = 0;
			let hints: SelectList | undefined;
			let pendingTab = false;
			let candidates: string[] = [];
			let explicitSelection = false;
			let status = "Loading directories...";

			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearTimeout(timer);
				request?.abort();
				ctx.signal?.removeEventListener("abort", cancel);
			};
			const finish = (value: string | undefined) => {
				if (disposed) return;
				dispose();
				done(value);
			};
			const cancel = () => finish(undefined);
			cleanup = dispose;

			function complete() {
				const selected = hints?.getSelectedItem();
				if (!selected) return;
				let common = "";
				for (const char of candidates[0]) {
					if (!candidates.every((value) => value.startsWith(common + char))) break;
					common += char;
				}
				if (explicitSelection || candidates.length === 1) setInput(selected.value);
				else if (common.length > input.getValue().length) setInput(common);
				else {
					status = "Multiple directories. Use ↑↓ then Tab to choose a hint.";
					return;
				}
				refresh();
			}

			function refresh(immediate = false) {
				clearTimeout(timer);
				request?.abort();
				const current = ++generation;
				const value = input.getValue();
				hints = undefined;
				candidates = [];
				explicitSelection = false;
				pendingTab = false;
				status = "Loading directories...";
				timer = setTimeout(() => {
					const controller = new AbortController();
					request = controller;
					void directoryHints(remote, value, controller.signal).then((items) => {
						if (disposed || current !== generation) return;
						candidates = items;
						status = items.length ? "" : "No matching directories.";
						hints = items.length ? new SelectList(items.map((value) => ({ value, label: value })), 6, {
							selectedPrefix: (s) => theme.fg("accent", s),
							selectedText: (s) => theme.fg("accent", s),
							description: (s) => theme.fg("muted", s),
							scrollInfo: (s) => theme.fg("dim", s),
							noMatch: (s) => theme.fg("dim", s),
						}) : undefined;
						if (pendingTab) { pendingTab = false; complete(); }
						tui.requestRender();
					}).catch((error: Error) => {
						if (disposed || current !== generation) return;
						status = `${error.message} Tab retries hints; Enter accepts the input.`;
						pendingTab = false;
						tui.requestRender();
					});
				}, immediate ? 0 : REFRESH_DELAY_MS);
				tui.requestRender();
			}

			input.onSubmit = (value) => {
				try { finish(chosenPath(value, home)); }
				catch { status = "Remote directory paths cannot contain control characters."; }
			};
			input.onEscape = cancel;
			ctx.signal?.addEventListener("abort", cancel, { once: true });
			refresh(true);
			// A deferred check avoids calling done before Pi installs the component.
			if (ctx.signal?.aborted) queueMicrotask(cancel);

			return {
				get focused() { return input.focused; },
				set focused(value: boolean) { input.focused = value; },
				invalidate() { input.invalidate(); hints?.invalidate(); },
				dispose,
				render(width: number) {
					if (width < 1) return [];
					const fit = (s: string) => truncateToWidth(s, width, "");
					return [
						fit(theme.fg("accent", "Remote directory")),
						fit(theme.fg("dim", "Empty or ~ = remote home. Relative paths start at home. Spaces are literal.")),
						...input.render(width).map(fit),
						...(width >= 4 && hints ? hints.render(width).map(fit) : []),
						...(status ? [fit(theme.fg("muted", status))] : []),
						fit(theme.fg("dim", "↑↓ choose hint · Tab complete whole path · Enter accept input · Esc cancel")),
					];
				},
				handleInput(data: string) {
					if (disposed) return;
					if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
						cancel();
					} else if (kb.matches(data, "tui.input.tab")) {
						if (hints) complete();
						else if (status === "Loading directories...") pendingTab = true;
						else refresh(true);
					} else if (hints && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
						explicitSelection = true;
						hints.handleInput(data);
					} else {
						const before = input.getValue();
						input.handleInput(data);
						if (CONTROL.test(input.getValue())) {
							input.setValue(before);
							status = "Remote directory paths cannot contain control characters.";
						} else if (!disposed && input.getValue() !== before) refresh();
					}
					if (!disposed) tui.requestRender();
				},
			};
		});
		// Legacy RPC implementations resolve custom() without invoking its factory.
		return !factoryCalled && !ctx.signal?.aborted ? fallback() : result;
	} catch (error) {
		// Older clients can also reject unsupported custom dialogs before the factory runs.
		if (!factoryCalled && !ctx.signal?.aborted) return fallback();
		throw error;
	} finally {
		cleanup?.();
	}
}
