import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./config.ts";

export const INHERITED_CONFIG_ENV = "PI_CODING_AGENT_SSH_REMOTE_CONFIG";

/** CLI settings take precedence over settings inherited by subprocesses. */
export function startupConfigPath(pi: Pick<ExtensionAPI, "getFlag">): string | undefined {
	const flag = pi.getFlag("ssh-remote-config");
	const value = typeof flag === "string" ? flag : process.env[INHERITED_CONFIG_ENV];
	if (value === undefined) return undefined;
	if (!value.trim()) throw new Error("--ssh-remote-config requires a non-empty settings file path.");
	return path.resolve(expandHome(value));
}
