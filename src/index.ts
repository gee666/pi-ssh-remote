/**
 * pi ssh remote - run pi's read/write/edit/bash tools transparently on a
 * remote SSH project.
 *
 * Architecture: one persistent ssh2 connection per session (see
 * connection.ts), SFTP for file operations, exec channels for bash
 * (see operations.ts). Nothing is installed on the remote host; a standard
 * sshd with the SFTP subsystem and a POSIX shell is enough.
 */

import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
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
function registerFailClosedTools(pi: ExtensionAPI, localCwd: string, message: string): void {
	const refuse = () => Promise.reject(new Error(`SSH remote mode is active but unavailable: ${message}`));
	pi.registerTool(createReadTool(localCwd, { operations: { readFile: refuse, access: refuse } }));
	pi.registerTool(createWriteTool(localCwd, { operations: { writeFile: refuse, mkdir: refuse } }));
	pi.registerTool(createEditTool(localCwd, { operations: { readFile: refuse, writeFile: refuse, access: refuse } }));
	pi.registerTool(createBashTool(localCwd, { operations: failClosedBashOps(message) }));
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
	pi.registerFlag("ssh-remote-project", {
		description: "Project selector for --ssh in non-interactive mode (title, server name, path, or 1-based index)",
		type: "string",
	});

	let connection: RemoteConnection | null = null;
	let fatalStartupError: string | null = null;
	let startupWarning: string | null = null;
	const localCwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		const inheritedProject = process.env[INHERITED_PROJECT_ENV];
		if (pi.getFlag("ssh") !== true && !inheritedProject) return;

		try {
			fatalStartupError = null;
			startupWarning = null;
			connection?.dispose();
			connection = null;
			const project = await selectProject(pi, ctx);
			process.env[INHERITED_PROJECT_ENV] = formatInheritedProject(project);

			const remote = new RemoteConnection(project);
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

			connection = remote;
			pi.registerTool(createReadTool(remote.remoteCwd, { operations: createRemoteReadOps(remoteFs) }));
			pi.registerTool(createWriteTool(remote.remoteCwd, { operations: createRemoteWriteOps(remoteFs) }));
			pi.registerTool(createEditTool(remote.remoteCwd, { operations: createRemoteEditOps(remoteFs) }));
			pi.registerTool(createBashTool(remote.remoteCwd, { operations: createRemoteBashOps(remote, localCwd) }));

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
			registerFailClosedTools(pi, localCwd, message);
			redError(message);
			ctx.ui.setStatus("ssh-remote", dimStatus(ctx, "SSH setup failed"));
			if (ctx.hasUI) ctx.ui.notify(message, "error");
		}
	});

	pi.on("user_bash", () => {
		if (!connection) {
			if (!fatalStartupError) return;
			return { operations: failClosedBashOps(fatalStartupError) };
		}
		return { operations: createRemoteBashOps(connection, localCwd) };
	});

	pi.on("before_agent_start", (event) => {
		if (!connection) {
			if (!fatalStartupError) return;
			return {
				systemPrompt:
					`${event.systemPrompt}\n\nSSH remote mode was requested, but setup failed before remote tools could be registered. ` +
					`Do not inspect or modify the local fallback directory as if it were the remote project. ` +
					`Explain this SSH setup error to the user and ask them to fix it: ${fatalStartupError}`,
			};
		}
		const remote = connection;
		let replaced = event.systemPrompt.replaceAll(`Current working directory: ${localCwd}`, `Current working directory: ${remote.remoteCwd}`);
		// Replace other mentions of the local cwd, but only when it is specific
		// enough that a blanket replacement cannot mangle unrelated paths
		// (think localCwd === "/" or "/tmp").
		if (localCwd.length > 5) replaced = replaced.replaceAll(localCwd, remote.remoteCwd);
		const warning = startupWarning
			? ` The startup connection attempt failed (${startupWarning}), but the connection re-establishes automatically, so tool calls should be retried.`
			: "";
		return {
			systemPrompt:
				`${replaced}\n\nSSH remote mode is active. The current project root is ${remote.remoteCwd} on the remote server ` +
				`'${remote.projectRef.serverName}' (${remote.target}); the read, write, edit, and bash tools operate there transparently ` +
				`over a persistent SSH connection. Always use POSIX paths under ${remote.remoteCwd}.${warning} ` +
				`If an SSH operation reports an authentication, host-key, network, timeout, or missing-path error, explain it clearly ` +
				`to the user instead of repeatedly retrying the same action.`,
		};
	});
}
