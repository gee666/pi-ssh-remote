/**
 * pi ssh remote - run pi's read/write/edit/bash tools transparently on a
 * remote SSH project.
 *
 * Architecture: one persistent ssh2 connection per session (see
 * connection.ts), SFTP for file operations, exec channels for bash
 * (see operations.ts). Nothing is installed on the remote host; a standard
 * sshd with the SFTP subsystem and a POSIX shell is enough.
 */

import type { BashOperations, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_PATH,
	INHERITED_PROJECT_ENV,
	formatInheritedProject,
	loadProjects,
	matchInheritedProject,
	matchProject,
	type RemoteProject,
} from "./config.ts";
import { RemoteConnection } from "./connection.ts";
import { RemoteFsRouter } from "./remote-fs.ts";
import { withLocalSkillReads } from "./skill-read.ts";
import { createRemoteSearchTools } from "./search-tools.ts";
import { FriendlySshError, isFriendly } from "./errors.ts";
import { createRemoteBashOps, createRemoteEditOps, createRemoteReadOps, createRemoteWriteOps } from "./operations.ts";

const RED = "\u001b[31m";
const RESET = "\u001b[0m";

function redError(message: string): void {
	console.error(`${RED}${message}${RESET}`);
}

function dimStatus(ctx: ExtensionContext, text: string): string {
	return typeof ctx.ui?.theme?.fg === "function" ? ctx.ui.theme.fg("dim", text) : text;
}

/**
 * Tools that fail closed with the SSH setup error. Registered when remote
 * mode was requested but setup failed, so the agent can never silently fall
 * back to operating on the local filesystem.
 */
type Mode = "ssh" | "ssh-local" | "ssh-local-first";

function localTools(cwd: string): ToolDefinition[] {
	return [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd),
		createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

function namedTool<T extends { name: string; label: string; description: string }>(tool: T, suffix: string, location: string): T {
	return { ...tool, name: tool.name + suffix, label: tool.label + suffix,
		description: `${location} ${tool.description}` };
}

function registerFailClosedTools(pi: ExtensionAPI, localCwd: string, message: string, getSkillPaths: () => readonly string[], mode: Mode): void {
	const refuse = () => Promise.reject(new Error(`SSH remote mode is active but unavailable: ${message}`));
	const suffix = mode === "ssh-local-first" ? "-ssh" : "";
	const tools: ToolDefinition[] = [
		withLocalSkillReads(createReadTool(localCwd, { operations: { readFile: refuse, access: refuse } }), localCwd, getSkillPaths),
		createWriteTool(localCwd, { operations: { writeFile: refuse, mkdir: refuse } }),
		createEditTool(localCwd, { operations: { readFile: refuse, writeFile: refuse, access: refuse } }),
		createBashTool(localCwd, { operations: failClosedBashOps(message) }),
	];
	for (const tool of tools) pi.registerTool(namedTool(tool, suffix, "SSH unavailable."));
	if (mode !== "ssh") {
		for (const tool of [createGrepTool(localCwd), createFindTool(localCwd), createLsTool(localCwd)]) {
			pi.registerTool({ ...namedTool(tool, suffix, "SSH unavailable."), execute: refuse });
		}
	}
}

function failClosedBashOps(message: string): BashOperations {
	return {
		exec: async () => {
			throw new Error(`SSH remote mode is active but unavailable: ${message}`);
		},
	};
}

async function selectProject(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RemoteProject> {
	const projects = await loadProjects();
	if (projects.length === 0) {
		throw new Error(`SSH remote settings were not found. Add at least one server and project to ${CONFIG_PATH}.`);
	}

	const inheritedRequested = process.env[INHERITED_PROJECT_ENV];
	if (inheritedRequested) {
		const match = matchInheritedProject(projects, inheritedRequested);
		if (!match) throw new Error(`SSH remote project '${inheritedRequested}' from ${INHERITED_PROJECT_ENV} was not found in ${CONFIG_PATH}.`);
		return match;
	}

	const requested = pi.getFlag("ssh-remote-project") as string | undefined;
	if (requested) {
		const match = matchProject(projects, requested);
		if (!match) throw new Error(`SSH remote project '${requested}' was not found in ${CONFIG_PATH}.`);
		return match;
	}

	if (projects.length === 1) return projects[0];
	if (!ctx.hasUI) {
		throw new Error(`Multiple SSH remote projects are configured. In non-interactive mode set --ssh-remote-project or ${INHERITED_PROJECT_ENV}.`);
	}

	const labels = projects.map((project) => project.label);
	const choice = await ctx.ui.select("Select SSH remote project", labels);
	const selected = projects[labels.indexOf(choice ?? "")];
	if (!selected) throw new Error("No SSH remote project selected.");
	return selected;
}

export default function piSshRemote(pi: ExtensionAPI) {
	pi.registerFlag("ssh", {
		description: "Enable SSH remote mode and select a project from ~/.pi/agent/ssh-remote-config.json",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("ssh-local", {
		description: "Use SSH tools by default and expose local tools with a -local suffix",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("ssh-local-first", {
		description: "Use local tools by default and expose SSH tools with a -ssh suffix",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("ssh-remote-project", {
		description: "Project selector for SSH modes in non-interactive mode (title, server name, path, or 1-based index)",
		type: "string",
	});

	let mode: Mode = "ssh";
	let connection: RemoteConnection | null = null;
	let fatalStartupError: string | null = null;
	let startupWarning: string | null = null;
	const localCwd = process.cwd();
	let skillPaths: string[] = [];
	const getSkillPaths = () => skillPaths;

	pi.on("session_start", async (_event, ctx) => {
		const inheritedProject = process.env[INHERITED_PROJECT_ENV];
		const flags = (["ssh", "ssh-local", "ssh-local-first"] as const).filter((name) => pi.getFlag(name) === true);
		if (flags.length === 0 && !inheritedProject) return;
		mode = flags.includes("ssh-local-first") ? "ssh-local-first" : flags.includes("ssh-local") ? "ssh-local" : "ssh";
		if (mode !== "ssh") {
			for (const tool of localTools(localCwd)) {
				pi.registerTool(namedTool(tool, mode === "ssh-local" ? "-local" : "", `LOCAL machine. Working directory: ${localCwd}.`));
			}
		}

		try {
			if (flags.length > 1) throw new Error("Choose only one of --ssh, --ssh-local, or --ssh-local-first.");
			fatalStartupError = null;
			startupWarning = null;
			connection?.dispose();
			connection = null;
			const project = await selectProject(pi, ctx);
			process.env[INHERITED_PROJECT_ENV] = formatInheritedProject(project);

			const remote = new RemoteConnection(project);
			connection = remote;
			const remoteFs = new RemoteFsRouter(remote);
			remoteFs.onFallback = (reason) => {
				if (ctx.hasUI) ctx.ui.notify(`SSH remote: ${reason}`, "warning");
				else console.error(reason);
			};
			let needsPathValidation = false;
			remote.onStateChange = (state) => {
				if (state === "connected") {
					ctx.ui.setStatus("ssh-remote", dimStatus(ctx, `SSH: ${project.serverName}:${remote.remoteCwd}`));
					// If startup happened while the server was unreachable, the
					// configured path was never verified. Verify on first reconnect;
					// an invalid path then fails all operations closed.
					if (needsPathValidation) {
						needsPathValidation = false;
						remoteFs.resolveProjectCwd().catch((error: unknown) => {
							if (isFriendly(error) && error.kind === "remote-path") {
								remote.pathProblem = error;
								ctx.ui.setStatus("ssh-remote", dimStatus(ctx, `SSH path error: ${project.serverName}`));
								if (ctx.hasUI) ctx.ui.notify(error.message, "error");
							} else {
								needsPathValidation = true;
							}
						});
					}
				} else if (state === "reconnecting") {
					ctx.ui.setStatus("ssh-remote", dimStatus(ctx, `SSH reconnecting: ${project.serverName}`));
				} else {
					ctx.ui.setStatus("ssh-remote", dimStatus(ctx, `SSH unavailable: ${project.serverName}`));
				}
			};

			// Connect once at startup to verify access and resolve the project
			// path (it may be relative to the remote home directory).
			try {
				await remoteFs.resolveProjectCwd();
			} catch (error) {
				const friendly = isFriendly(error) ? error : new FriendlySshError(error instanceof Error ? error.message : String(error), "unknown", false);
				// Setup problems (bad auth, bad key, missing path, host-key
				// mismatch) fail closed: registering tools against a wrong or
				// unknown directory would let the agent damage the wrong files.
				if (!friendly.retryable) throw friendly;
				// A transient network problem should not kill the session if we
				// already know the exact remote directory.
				if (!project.project.path.startsWith("/")) {
					throw new FriendlySshError(
						`${friendly.message}\nThe configured project path '${project.project.path}' is relative, so it cannot be resolved while the server is unreachable. Retry when the connection recovers, or configure an absolute path in ${CONFIG_PATH}.`,
						friendly.kind,
						false,
					);
				}
				startupWarning = friendly.message;
				needsPathValidation = true;
				redError(friendly.message);
				if (ctx.hasUI) ctx.ui.notify(`SSH remote is not reachable yet; pi will keep running and reconnect automatically. ${friendly.message}`, "error");
			}

			const remoteTools: ToolDefinition[] = [
				withLocalSkillReads(createReadTool(remote.remoteCwd, { operations: createRemoteReadOps(remoteFs) }), localCwd, getSkillPaths),
				createWriteTool(remote.remoteCwd, { operations: createRemoteWriteOps(remoteFs) }),
				createEditTool(remote.remoteCwd, { operations: createRemoteEditOps(remoteFs) }),
				createBashTool(remote.remoteCwd, { operations: createRemoteBashOps(remote, localCwd) }),
				...(mode === "ssh" ? [] : createRemoteSearchTools(remote, localCwd)),
			];
			for (const tool of remoteTools) {
				pi.registerTool(namedTool(tool, mode === "ssh-local-first" ? "-ssh" : "", `SSH server ${project.serverName}. Working directory: ${remote.remoteCwd}.`));
			}

			ctx.ui.setTitle(`SSH ${project.project.title}`);
			if (!startupWarning) {
				ctx.ui.setStatus("ssh-remote", dimStatus(ctx, `SSH: ${project.serverName}:${remote.remoteCwd}`));
				if (ctx.hasUI) ctx.ui.notify(`SSH remote connected: ${project.label}`, "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fatalStartupError = message;
			connection?.dispose();
			connection = null;
			// Fail closed: replace the built-in tools with ones that refuse to
			// run, so the agent cannot mistake the local directory for the
			// remote project.
			registerFailClosedTools(pi, localCwd, message, getSkillPaths, mode);
			redError(message);
			ctx.ui.setStatus("ssh-remote", dimStatus(ctx, "SSH setup failed"));
			if (ctx.hasUI) ctx.ui.notify(message, "error");
		}
		if (mode !== "ssh") {
			// Overriding an inactive built-in does not activate it. Mixed modes
			// expose all seven tools on both machines, including search tools.
			const names = localTools(localCwd).map((tool) => tool.name);
			const suffix = mode === "ssh-local" ? "-local" : "-ssh";
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names, ...names.map((name) => name + suffix)])]);
		}
	});

	pi.on("session_shutdown", () => {
		connection?.dispose();
		connection = null;
	});

	pi.on("user_bash", () => {
		if (mode === "ssh-local-first") return;
		if (!connection) {
			if (!fatalStartupError) return;
			return { operations: failClosedBashOps(fatalStartupError) };
		}
		return { operations: createRemoteBashOps(connection, localCwd) };
	});

	pi.on("before_agent_start", (event) => {
		skillPaths = event.systemPromptOptions?.skills?.map((skill) => skill.filePath) ?? [];
		if (!connection) {
			if (!fatalStartupError) return;
			return {
				systemPrompt:
					`${event.systemPrompt}\n\nSSH remote mode was requested, but setup failed before remote tools could be registered. ` +
					(mode === "ssh-local-first"
						? `Unsuffixed tools and user ! commands still run locally in ${localCwd}; tools ending in -ssh refuse operations. `
						: `Do not inspect or modify the local fallback directory as if it were the remote project. ` +
							(mode === "ssh-local" ? `Explicit -local tools remain available in ${localCwd}. ` : "")) +
					`Explain this SSH setup error to the user and ask them to fix it: ${fatalStartupError}`,
			};
		}
		const remote = connection;
		if (mode === "ssh-local-first") {
			return {
				systemPrompt: `${event.systemPrompt}\n\nLocal-first SSH mode is active. ` +
					`Unsuffixed read, write, edit, bash, grep, find, and ls tools and user ! commands run LOCALLY in ${localCwd}. ` +
					`Use read-ssh, write-ssh, edit-ssh, bash-ssh, grep-ssh, find-ssh, and ls-ssh only for the SSH project ` +
					`${remote.remoteCwd} on '${remote.projectRef.serverName}' (${remote.target}). ` +
					`Paths for -ssh tools are remote POSIX paths. read-ssh still checks advertised skill paths locally first. ` +
					`Never confuse local files with remote files. ` +
					(startupWarning ? `SSH startup warning: ${startupWarning}. SSH tools reconnect automatically. ` : ""),
			};
		}
		// Preserve advertised local skill paths, including project/package skills.
		const replaced = event.systemPrompt.replaceAll(`Current working directory: ${localCwd}`, `Current working directory: ${remote.remoteCwd}`);
		const warning = startupWarning
			? ` The startup connection attempt failed (${startupWarning}), but the connection re-establishes automatically, so tool calls should be retried.`
			: "";
		return {
			systemPrompt:
				`${replaced}\n\n` +
				(mode === "ssh-local"
					? `SSH with local access is active. Unsuffixed grep, find, and ls also run remotely. ` +
						`Use read-local, write-local, edit-local, bash-local, grep-local, find-local, and ls-local for LOCAL files in ${localCwd}. ` +
						`User ! commands run remotely. Never confuse local files with remote files. `
					: "") +
				`SSH remote mode is active. The current project root is ${remote.remoteCwd} on the remote server ` +
				`'${remote.projectRef.serverName}' (${remote.target}); the read, write, edit, and bash tools operate there transparently ` +
				`over a persistent SSH connection. Use POSIX paths under ${remote.remoteCwd} for project files.${warning} ` +
				`For available skills and their supporting files, use read with their advertised paths unchanged: ` +
				`read checks locally first and uses the remote path only when the local skill file is absent. ` +
				`If an SSH operation reports an authentication, host-key, network, timeout, or missing-path error, explain it clearly ` +
				`to the user instead of repeatedly retrying the same action.`,
		};
	});
}
