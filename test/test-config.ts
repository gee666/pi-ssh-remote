import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

await mkdir("tmp", { recursive: true });
const root = await mkdtemp(path.resolve("tmp/config-"));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
process.env.HOME = root;
process.env.USERPROFILE = root;
const {
	CONFIG_PATH, expandHome, formatInheritedProject, loadProjects,
	matchInheritedProject, matchProject, saveProjectPath, serverHost, truncateMiddle,
} = await import("../src/config.ts");
assert.equal(CONFIG_PATH, path.join(root, ".pi", "agent", "ssh-remote-config.json"));

beforeEach(async () => {
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	await rm(CONFIG_PATH, { force: true });
});

after(async () => {
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
	await rm(root, { recursive: true, force: true });
});

async function writeConfig(config: unknown) {
	await writeFile(CONFIG_PATH, JSON.stringify(config));
}

async function readConfig() {
	return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

test("missing, blank, and empty configs still load no projects", async () => {
	assert.deepEqual(await loadProjects(), []);
	for (const raw of ["", " \n\t", "\uFEFF \n", "{}", "\uFEFF{}"]) {
		await writeFile(CONFIG_PATH, raw);
		assert.deepEqual(await loadProjects(), []);
	}
});

test("servers without projects load a synthetic Home without changing their settings", async () => {
	const config = {
		missing: { HostName: "missing.example", Password: "secret", custom: { enabled: true } },
		empty: { projects: [] },
		saved: { host: "saved.example", projects: [{ title: "App", path: "/srv/app" }] },
	};
	await writeConfig(config);
	const projects = await loadProjects();
	assert.deepEqual(projects.map(({ serverName, project }) => ({ serverName, project })), [
		{ serverName: "missing", project: { title: "Home", path: "." } },
		{ serverName: "empty", project: { title: "Home", path: "." } },
		{ serverName: "saved", project: { title: "App", path: "/srv/app" } },
	]);
	assert.deepEqual(projects[0].server, config.missing);
	assert.deepEqual(projects[1].server.projects, []);
	assert.equal(projects[0].label, "Home (missing <missing.example> - .)");
	assert.deepEqual(await readConfig(), config);
});

test("existing project order, labels, host aliases, and selection remain compatible", async () => {
	await writeFile(CONFIG_PATH, '\uFEFF{"alpha":{"Host":"example","projects":[{"title":"App","path":"~/app"},{"title":"Other","path":"/srv/other"}]}}');
	const projects = await loadProjects();
	assert.equal(projects.length, 2);
	assert.equal(projects[0].label, "App (alpha <example> - ~/app)");
	for (const wanted of ["1", "APP", "ALPHA", "~/app", projects[0].label.toUpperCase()]) {
		assert.equal(matchProject(projects, wanted), projects[0]);
	}
	assert.equal(matchProject(projects, "2"), projects[1]);
	assert.equal(matchProject(projects, "unknown"), undefined);
	assert.equal(serverHost("alias", {}), "alias");
	assert.equal(serverHost("alias", { hostName: "name" }), "name");
	assert.equal(serverHost("alias", { host: "first", Host: "second", HostName: "third" }), "first");
	assert.equal(expandHome("~/app"), path.join(root, "app"));
	assert.equal(expandHome("~"), root);
	assert.equal(expandHome("/srv/app"), "/srv/app");
	assert.equal(truncateMiddle("short"), "short");
	assert.equal(truncateMiddle("x".repeat(200)).length, 110);
});

test("invalid JSON and invalid server settings retain validation errors", async () => {
	await writeFile(CONFIG_PATH, "{");
	await assert.rejects(loadProjects(), /not valid JSON/);
	for (const [config, message] of [
		[[], /JSON object of servers/],
		[{ server: null }, /must be an object/],
		[{ server: { projects: {} } }, /expected an array/],
		[{ server: { password: 42 } }, /expected a string/],
		[{ server: { port: 0 } }, /invalid port/],
		[{ server: { Port: "65536" } }, /invalid port/],
		[{ server: { projects: [null] } }, /must be an object/],
		[{ server: { projects: [{ title: " ", path: "/app" }] } }, /non-empty string 'title'/],
		[{ server: { projects: [{ title: "App", path: " " }] } }, /non-empty string 'path'/],
	] as const) {
		await writeConfig(config);
		await assert.rejects(loadProjects(), message);
	}
});

test("inherited saved projects keep exact matches and legacy formats", async () => {
	await writeConfig({ alpha: { projects: [{ title: "Custom title", path: "relative/app" }] } });
	const projects = await loadProjects();
	assert.equal(formatInheritedProject(projects[0]), "alpha::relative/app");
	for (const wanted of [
		" alpha::relative/app ",
		'{"serverName":"alpha","projectPath":"relative/app"}',
		'{"server":"alpha","path":"relative/app"}',
		'{"serverId":"alpha","path":"relative/app"}',
		"Custom title", "1",
	]) {
		assert.equal(matchInheritedProject(projects, wanted), projects[0]);
	}
});

test("subagents can inherit unsaved absolute paths for configured servers only", async () => {
	await writeConfig({
		empty: { passwordEnv: "SSH_PASSWORD" },
		alpha: { host: "example", projects: [{ title: "App", path: "/srv/app" }] },
	});
	const projects = await loadProjects();
	const before = structuredClone(projects);
	for (const serverName of ["empty", "alpha"]) {
		for (const projectPath of ["/srv/new app", "/", "/srv/a::b"]) {
			for (const wanted of [
				`${serverName}::${projectPath}`,
				JSON.stringify({ serverName, projectPath }),
				JSON.stringify({ server: serverName, path: projectPath }),
				JSON.stringify({ serverId: serverName, path: projectPath }),
			]) {
				const inherited = matchInheritedProject(projects, wanted);
				assert.ok(inherited);
				assert.equal(inherited.serverName, serverName);
				assert.equal(inherited.project.path, projectPath);
				assert.equal(inherited.server, projects.find((p) => p.serverName === serverName)!.server);
				assert.equal(formatInheritedProject(inherited), `${serverName}::${projectPath}`);
				assert.ok(inherited.project.title.length > 0);
				assert.ok(inherited.label.includes(serverName));
			}
		}
	}
	for (const wanted of ["", " ", "unknown::/srv/app", "alpha::relative", "alpha::~/app", "alpha::", '{"server":"unknown","path":"/srv/app"}']) {
		assert.equal(matchInheritedProject(projects, wanted), undefined);
	}
	assert.deepEqual(projects, before);
	assert.deepEqual(await loadProjects(), before);
});

test("saving appends a path while retaining authentication, unknown fields, and project metadata", async () => {
	const config = {
		alpha: {
			HostName: "example", User: "alice", Port: "2222", IdentityFile: "~/.ssh/key",
			passphrase: "private", passphraseEnv: "KEY_PHRASE", Password: "secret",
			PasswordEnv: "SSH_PASSWORD", IdentitiesOnly: "yes", sshOptions: { ProxyJump: "gateway" },
			custom: { nested: [1, "two"] },
			projects: [{ title: "Keep this title", path: "/srv/app", custom: { color: "red" } }],
		},
		other: { host: "other.example", password: "other secret", unknown: false },
	};
	await writeConfig(config);
	await saveProjectPath("alpha", "/srv/new app");
	const saved = await readConfig();
	assert.deepEqual(saved, {
		...config,
		alpha: { ...config.alpha, projects: [...config.alpha.projects, { title: "new app", path: "/srv/new app" }] },
	});
	const projects = await loadProjects();
	assert.equal(projects[1].project.path, "/srv/new app");
	assert.equal(projects[2].project.path, ".");
	const raw = await readFile(CONFIG_PATH, "utf8");
	const info = await stat(CONFIG_PATH);
	await saveProjectPath("alpha", "/srv/app");
	await saveProjectPath("alpha", "/srv/new app");
	assert.equal(await readFile(CONFIG_PATH, "utf8"), raw);
	assert.equal((await stat(CONFIG_PATH)).ino, info.ino, "duplicates do not rewrite the file");
});

test("saving the first path does not persist synthetic Home entries", async () => {
	for (const settings of [{ host: "example" }, { host: "example", projects: [] }]) {
		await writeConfig({ alpha: settings });
		await saveProjectPath("alpha", "/home/alice");
		assert.deepEqual((await readConfig()).alpha.projects, [{ title: "alice", path: "/home/alice" }]);
		assert.equal((await loadProjects()).length, 1);
	}
	await saveProjectPath("alpha", "/");
	assert.deepEqual((await readConfig()).alpha.projects[1], { title: "/", path: "/" });
});

test("saving accepts BOM configs and preserves servers named like object properties", async () => {
	await writeFile(CONFIG_PATH, '\uFEFF{"__proto__":{"password":"secret"},"constructor":{}}');
	assert.equal((await loadProjects()).length, 2);
	await saveProjectPath("__proto__", "/srv/app");
	assert.deepEqual(await readConfig(), JSON.parse('{"__proto__":{"password":"secret","projects":[{"title":"app","path":"/srv/app"}]},"constructor":{}}'));
	await saveProjectPath("constructor", "/srv/other");
	assert.equal((await readConfig()).constructor.projects[0].path, "/srv/other");
});

test("saving replaces the config atomically with private permissions and no temporary leftovers", async () => {
	await writeFile(CONFIG_PATH, '{"alpha":{"password":"secret"}}', { mode: 0o644 });
	const before = await stat(CONFIG_PATH);
	await saveProjectPath("alpha", "/srv/app");
	const after = await stat(CONFIG_PATH);
	if (process.platform !== "win32") {
		assert.equal(after.mode & 0o777, 0o600);
		assert.notEqual(after.ino, before.ino, "the old file is replaced, not truncated in place");
	}
	assert.deepEqual(await readdir(path.dirname(CONFIG_PATH)), [path.basename(CONFIG_PATH)]);
});

test("atomic saving replaces a symlink rather than writing through it", { skip: process.platform === "win32" }, async () => {
	const target = path.join(root, "symlink-target.json");
	const raw = '{"alpha":{"password":"secret"}}';
	await writeFile(target, raw);
	await symlink(target, CONFIG_PATH);
	await saveProjectPath("alpha", "/srv/app");
	assert.equal(await readFile(target, "utf8"), raw);
	assert.equal((await readConfig()).alpha.projects[0].path, "/srv/app");
});

test("failed saves leave missing, invalid, and unknown-server configs untouched", async () => {
	await assert.rejects(saveProjectPath("alpha", "/srv/app"), /ENOENT/);
	for (const raw of ["{", "[]", '{"alpha":{"projects":false}}', "", "{}", '{"other":{"password":"secret"}}']) {
		await writeFile(CONFIG_PATH, raw);
		await assert.rejects(saveProjectPath("alpha", "/srv/app"));
		assert.equal(await readFile(CONFIG_PATH, "utf8"), raw);
	}
	await writeConfig({ alpha: {} });
	for (const projectPath of ["", " \n"]) {
		await assert.rejects(saveProjectPath("alpha", projectPath), /non-empty string/);
	}
	await assert.rejects(saveProjectPath("toString", "/srv/app"), /not configured/);
	assert.deepEqual(await readConfig(), { alpha: {} });
	assert.deepEqual(await readdir(path.dirname(CONFIG_PATH)), [path.basename(CONFIG_PATH)]);
	await saveProjectPath("alpha", "/srv/app");
	assert.equal((await readConfig()).alpha.projects.length, 1, "a failed save does not block later saves");
});

test("concurrent saves retain distinct paths and deduplicate repeated paths", async () => {
	await writeConfig({ alpha: {}, beta: { Password: "secret" } });
	await Promise.all([
		saveProjectPath("alpha", "/srv/one"),
		saveProjectPath("alpha", "/srv/two"),
		saveProjectPath("alpha", "/srv/one"),
		saveProjectPath("beta", "/srv/three"),
	]);
	assert.deepEqual(await readConfig(), {
		alpha: { projects: [{ title: "one", path: "/srv/one" }, { title: "two", path: "/srv/two" }] },
		beta: { Password: "secret", projects: [{ title: "three", path: "/srv/three" }] },
	});
});
