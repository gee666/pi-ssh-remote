/**
 * Optional SSH search tools for mixed local/remote sessions. Registration and
 * naming belong to the caller; constructing these tools does not connect or
 * change plain --ssh mode. No command or filesystem probe runs locally.
 *
 * Remote requirements: bash; rg for grep; fd with --no-require-git and
 * --max-results for find. ls uses only bash builtins. All calls have a 60s
 * timeout. Output is head-truncated in memory, without local spill files.
 */
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	DEFAULT_MAX_BYTES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { RemoteConnection } from "./connection.ts";
import { CONFIG_PATH } from "./config.ts";
import { FriendlySshError, classifyConnectionError } from "./errors.ts";

const TIMEOUT = 60;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function quote(value: string): string {
	if (value.includes("\0")) throw new Error("Search arguments cannot contain NUL bytes");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function integer(value: number | undefined, fallback: number, name: string, minimum = 1): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}`);
	}
	return result;
}

// Resolve on the server, never via local homedir/path.resolve. A literal '$',
// backtick, newline, or quote in a path stays literal. Only ~/ expands.
function searchPath(value?: string): string {
	const input = (value || ".").replace(/^@/, "");
	const expression = input === "~" ? '"$HOME"'
		: input.startsWith("~/") ? `"$HOME"/${quote(input.slice(2))}` : quote(input);
	return `search_path=${expression}\ncase "$search_path" in /*) ;; *) search_path="$PWD/$search_path" ;; esac\n`;
}

class Output {
	private text = "";
	private full = false;

	add(line: string): void {
		if (this.full) return;
		this.text += (this.text ? "\n" : "") + line;
		// Retain just enough to let truncateHead report byte truncation.
		if (Buffer.byteLength(this.text) > DEFAULT_MAX_BYTES) this.full = true;
	}

	result(empty: string, details: Record<string, unknown> = {}, notices: string[] = []) {
		const truncation = truncateHead(this.text, { maxLines: Number.MAX_SAFE_INTEGER });
		if (truncation.truncated) {
			details.truncation = truncation;
			notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached. Refine the search or path`);
		}
		const text = (truncation.content || empty) + (notices.length ? `\n\n[${notices.join(". ")}]` : "");
		return { content: [{ type: "text" as const, text }], details: Object.keys(details).length ? details : undefined };
	}
}

interface RgText { text?: string; bytes?: string }
function rgText(value: RgText): string {
	return value.text ?? Buffer.from(value.bytes ?? "", "base64").toString("utf8");
}

export function createRemoteSearchTools(remote: RemoteConnection, localCwd: string) {
	// Read stdout separately from stderr. A record callback returns true when
	// enough results have arrived; closing that channel is a successful stop,
	// not a command failure. Match the bash operations' timeout/close grace.
	async function run(command: string, separator: string, record: (value: string) => boolean | void,
		signal?: AbortSignal, acceptedCodes = [0]): Promise<void> {
		if (signal?.aborted) throw new Error("Operation aborted");
		const script = `cd ${quote(remote.remoteCwd)} && { ${command}\n}`;
		let channel;
		try {
			channel = await remote.execChannel(`bash -c ${quote(script)}`);
		} catch (error) {
			if (signal?.aborted) throw new Error("Operation aborted");
			throw classifyConnectionError(error, remote.target, CONFIG_PATH);
		}
		return new Promise<void>((resolve, reject) => {
			const stdout = new StringDecoder("utf8");
			const stderr = new StringDecoder("utf8");
			let pending = "";
			let outputTail = "";
			let errorTail = "";
			let finished = false;
			let stopping = false;
			let closed = false;
			let failure: Error | undefined;
			let sawExit = false;
			let exitCode: number | null = null;
			let graceTimer: NodeJS.Timeout | undefined;
			const finish = (error = failure) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				if (graceTimer) clearTimeout(graceTimer);
				signal?.removeEventListener("abort", onAbort);
				channel.off("data", onData);
				channel.stderr.off("data", onStderr);
				if (signal?.aborted) error = new Error("Operation aborted");
				if (error) reject(error); else resolve();
			};
			const stop = (error?: Error) => {
				if (finished) return;
				if (error) failure = error;
				if (closed) { finish(); return; }
				if (stopping) return;
				stopping = true;
				pending = "";
				clearTimeout(timer);
				// Arm before close(), which may synchronously emit 'close'.
				graceTimer = setTimeout(() => {
					remote.invalidateCurrent();
					finish();
				}, 5000);
				try { channel.close(); } catch (error) {
					finish(failure ?? classifyConnectionError(error, remote.target, CONFIG_PATH));
				}
			};
			const consume = (text: string) => {
				if (stopping || finished) return;
				outputTail = (outputTail + text).slice(-4096);
				try {
					pending += text;
					let index;
					while ((index = pending.indexOf(separator)) !== -1) {
						const value = pending.slice(0, index);
						pending = pending.slice(index + separator.length);
						if (Buffer.byteLength(value) > MAX_RECORD_BYTES) {
							throw new Error("Remote search record exceeds 16MB. Refine the search or path");
						}
						if (record(value) === true) { stop(); return; }
					}
					if (Buffer.byteLength(pending) > MAX_RECORD_BYTES) {
						throw new Error("Remote search record exceeds 16MB. Refine the search or path");
					}
				} catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
			};
			const onData = (data: Buffer) => consume(stdout.write(data));
			const onStderr = (data: Buffer) => { errorTail = (errorTail + stderr.write(data)).slice(-4096); };
			const onAbort = () => stop(new Error("Operation aborted"));
			const timer = setTimeout(() => stop(new Error(`timeout:${TIMEOUT}`)), TIMEOUT * 1000);
			channel.on("data", onData);
			channel.stderr.on("data", onStderr);
			channel.on("exit", (code: number | null) => { sawExit = true; exitCode = code; });
			channel.on("error", (error: Error) => {
				if (stopping) finish();
				else stop(classifyConnectionError(error, remote.target, CONFIG_PATH));
			});
			channel.on("close", (code?: number | null) => {
				closed = true;
				if (finished) return;
				if (stopping) { finish(); return; }
				if (!sawExit && typeof code === "number") { sawExit = true; exitCode = code; }
				errorTail = (errorTail + stderr.end()).slice(-4096);
				if (!sawExit || exitCode === null) {
					finish(new FriendlySshError(`SSH connection to ${remote.target} dropped while searching.`, "connection", true));
					return;
				}
				if (!acceptedCodes.includes(exitCode)) {
					finish(new Error(`${errorTail.trim() || outputTail.trim() || "Remote search failed"}\nCommand exited with code ${exitCode}`));
					return;
				}
				consume(stdout.end());
				try { if (!finished && pending) record(pending); }
				catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
				finish();
			});
			// Covers cancellation while execChannel was establishing the connection.
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	const grep: ReturnType<typeof createGrepTool> = {
		...createGrepTool(localCwd),
		description: "Search file contents over SSH only. Requires rg on the remote PATH and bash. Returns matching lines with paths and line numbers, including dotfiles and respecting ignore files. Supports regex, literal, ignoreCase, glob and context. Defaults to 100 matches globally; output is head-truncated to 50KB and long lines to 500 characters. Context blocks may be merged by rg. Paths are remote POSIX paths relative to the remote project; ~/ uses the remote home. Timeout: 60s.",
		async execute(_id, params, signal) {
			const limit = integer(params.limit, 100, "limit");
			const context = integer(params.context, 0, "context", 0);
			const args = ["rg", "--no-config", "--json", "--line-number", "--color=never", "--hidden"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", params.glob);
			if (context) args.push("--context", String(context));
			args.push("--", params.pattern);
			const command = args.map(quote).join(" ");
			const output = new Output();
			let matches = 0;
			let lastMatchPath = "";
			let lastMatchLine = 0;
			let linesTruncated = false;
			await run(searchPath(params.path) + `if [ -d "$search_path" ]; then
	cd -- "$search_path" || exit 2
	${command} .
else
	${command} "$search_path"
fi`, "\n", (line) => {
				if (!line) return;
				const event = JSON.parse(line) as {
					type: string;
					data: { path: RgText; lines: RgText; line_number: number };
				};
				// EOF can arrive before all requested trailing context lines.
				if (event.type === "end" && matches >= limit) return true;
				if (event.type !== "match" && event.type !== "context") return;
				const file = rgText(event.data.path);
				const trailing = matches >= limit;
				if (trailing && (file !== lastMatchPath || event.data.line_number > lastMatchLine + context)) return true;
				if (event.type === "match" && !trailing) {
					matches++;
					lastMatchPath = file;
					lastMatchLine = event.data.line_number;
				}
				// Directory searches start at '.', file searches use the basename.
				const displayPath = file.startsWith("./") ? file.slice(2) : path.posix.basename(file);
				const { text, wasTruncated } = truncateLine(rgText(event.data.lines).replace(/\r?\n$/, ""));
				linesTruncated ||= wasTruncated;
				const separator = event.type === "match" && !trailing ? ":" : "-";
				output.add(`${displayPath}${separator}${event.data.line_number}${separator} ${text}`);
				return matches >= limit && event.data.line_number >= lastMatchLine + context;
			}, signal, [0, 1]);
			const details: Record<string, unknown> = {};
			const notices: string[] = [];
			if (matches >= limit) {
				details.matchLimitReached = limit;
				notices.push(`${limit} matches limit reached. Increase limit or refine pattern`);
			}
			if (linesTruncated) {
				details.linesTruncated = true;
				notices.push("Some lines truncated. Use read for full lines");
			}
			return output.result("No matches found", details, notices);
		},
	};

	const find: ReturnType<typeof createFindTool> = {
		...createFindTool(localCwd),
		description: "Find files and directories by glob over SSH only. Requires fd on the remote PATH with --no-require-git and --max-results support, and bash. Includes dotfiles, respects ignore files, and returns paths relative to the search directory. Path-containing globs match full paths. Defaults to 1000 results and 50KB of head-truncated output. Paths are remote POSIX paths relative to the remote project; ~/ uses the remote home. Timeout: 60s.",
		async execute(_id, params, signal) {
			const limit = integer(params.limit, 1000, "limit");
			let pattern = params.pattern;
			const args = ["fd", "--glob", "--color=never", "--hidden", "--no-require-git", "--print0", "--max-results", String(limit)];
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
			}
			args.push("--", pattern, ".");
			const output = new Output();
			let count = 0;
			await run(searchPath(params.path) + `cd -- "$search_path" || exit 2\n${args.map(quote).join(" ")}`,
				"\0", (entry) => {
					if (entry && count++ < limit) output.add(entry.replace(/^\.\//, ""));
				}, signal);
			return count >= limit
				? output.result("No files found matching pattern", { resultLimitReached: limit }, [`${limit} results limit reached. Increase limit or refine pattern`])
				: output.result("No files found matching pattern");
		},
	};

	const ls: ReturnType<typeof createLsTool> = {
		...createLsTool(localCwd),
		description: "List a remote directory over SSH only using bash builtins. Includes dotfiles, sorts case-insensitively and appends '/' to directories. Defaults to 500 entries and 50KB of head-truncated output. Paths are remote POSIX paths relative to the remote project; ~/ uses the remote home. Timeout: 60s.",
		async execute(_id, params, signal) {
			const limit = integer(params.limit, 500, "limit");
			const entries: string[] = [];
			let count = 0;
			const compare = (a: string, b: string) => a.replace(/\/$/, "").toLowerCase().localeCompare(b.replace(/\/$/, "").toLowerCase());
			// Keep only the smallest limit entries, sorted. The remote shell's
			// glob order need not match the native case-insensitive ordering.
			const retain = (entry: string) => {
				if (!entry) return;
				count++;
				if (entries.length === limit && compare(entry, entries[limit - 1]) >= 0) return;
				let low = 0, high = entries.length;
				while (low < high) {
					const middle = Math.floor((low + high) / 2);
					if (compare(entries[middle], entry) <= 0) low = middle + 1;
					else high = middle;
				}
				if (entries.length === limit) entries.pop();
				entries.splice(low, 0, entry);
			};
			await run(searchPath(params.path) + `cd -- "$search_path" || exit 2
shopt -s dotglob nullglob
for entry in ./*; do
	if [ -d "$entry" ]; then
		printf '%s/\\0' "\${entry#./}"
	else
		printf '%s\\0' "\${entry#./}"
	fi
done`, "\0", retain, signal);
			const output = new Output();
			for (const entry of entries) output.add(entry);
			return count > limit
				? output.result("(empty directory)", { entryLimitReached: limit }, [`${limit} entries limit reached. Increase limit for more`])
				: output.result("(empty directory)");
		},
	};

	return [grep, find, ls] as [typeof grep, typeof find, typeof ls];
}
