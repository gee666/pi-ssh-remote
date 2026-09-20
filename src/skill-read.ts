import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";

/** Only advertised skills qualify for local reads, not arbitrary project files. */
export function withLocalSkillReads(
	remoteRead: ReturnType<typeof createReadTool>,
	localCwd: string,
	getSkillPaths: () => readonly string[],
): ReturnType<typeof createReadTool> {
	const localRead = createReadTool(localCwd);
	return {
		...remoteRead,
		async execute(id, params, signal, onUpdate) {
			let requested = params.path.replace(/^@/, "");
			if (requested.startsWith("~/")) requested = homedir() + requested.slice(1);
			const localPath = resolve(localCwd, requested);
			const isSkill = getSkillPaths().some((file) => {
				const skillPath = resolve(localCwd, file);
				// Directory skills may refer to supporting documents and images.
				// Standalone skill markdown files must not expose their whole parent.
				return localPath === skillPath ||
					(basename(skillPath) === "SKILL.md" && localPath.startsWith(dirname(skillPath) + sep));
			});
			if (isSkill) {
				try {
					await stat(localPath);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
					return remoteRead.execute(id, params, signal, onUpdate);
				}
				return localRead.execute(id, { ...params, path: localPath }, signal, onUpdate);
			}
			return remoteRead.execute(id, params, signal, onUpdate);
		},
	};
}
