// End-to-end integration test: client stack (connection + operations)
// against the local ssh2 test server. Covers connect, relative path
// resolution, file ops, bash, errors, reconnect, and host-key pinning.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RemoteConnection } from "../src/connection.ts";
import { KNOWN_HOSTS_PATH, type RemoteProject } from "../src/config.ts";
import { RemoteFsRouter } from "../src/remote-fs.ts";
import { createRemoteBashOps, createRemoteEditOps, createRemoteReadOps, createRemoteWriteOps } from "../src/operations.ts";
import { startServer } from "./test-server.ts";

const PORT = 12222;
const TMP = path.resolve("tmp");
const SANDBOX = path.join(TMP, "remote-root");
const PROJECT_DIR = path.join(SANDBOX, "project");
const HOSTKEY = path.join(TMP, "hostkey_ed25519");
const HOSTKEY2 = path.join(TMP, "hostkey2_ed25519");

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// --- setup ---
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, "hello.txt"), "hello remote\n");
for (const key of [HOSTKEY, HOSTKEY2]) {
	fs.rmSync(key, { force: true });
	fs.rmSync(`${key}.pub`, { force: true });
	execSync(`ssh-keygen -t ed25519 -f ${key} -N '' -q`);
}
// Clean known-hosts pin from previous runs
try {
	const hosts = JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, "utf8"));
	delete hosts[`127.0.0.1:${PORT}`];
	fs.writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(hosts, null, "\t"));
} catch {}

const projectRef: RemoteProject = {
	serverName: "local-test",
	server: { host: "127.0.0.1", port: PORT, user: "test", password: "testpass" },
	project: { title: "Local Test", path: "project" }, // relative -> tests realpath resolution
	label: "Local Test (local-test)",
};

let server = await startServer({ port: PORT, hostKeyPath: HOSTKEY, sandbox: SANDBOX });

const remote = new RemoteConnection(projectRef);
const router = new RemoteFsRouter(remote);
const states: string[] = [];
remote.onStateChange = (s) => states.push(s);

// 1. connect + relative project path resolution
const cwd = await router.resolveProjectCwd();
check("connect + resolve relative project path", cwd === fs.realpathSync(PROJECT_DIR), cwd);

const read = createRemoteReadOps(router);
const write = createRemoteWriteOps(router);
const edit = createRemoteEditOps(router);
const bash = createRemoteBashOps(remote, process.cwd());

// 2. read
const hello = await read.readFile(path.join(cwd, "hello.txt"));
check("read file", hello.toString() === "hello remote\n");

// 3. ENOENT mapping
const missing = await read.readFile(path.join(cwd, "nope.txt")).then(() => null, (e) => e);
check("missing file -> ENOENT", missing?.code === "ENOENT", missing?.message);

// 4. mkdir -p + write + read roundtrip with awkward names
const dir = path.join(cwd, "a/b/c dir");
await write.mkdir(dir);
const tricky = path.join(dir, "it's \u00e9\u00e8 file.txt");
await write.writeFile(tricky, "line1\nline2 with 'quotes'\n");
check("mkdir -p + write + read", (await read.readFile(tricky)).toString() === "line1\nline2 with 'quotes'\n");

// 5. edit ops (read-modify-write)
await edit.writeFile(tricky, (await edit.readFile(tricky)).toString().replace("line2", "LINE2"));
check("edit roundtrip", (await read.readFile(tricky)).toString().includes("LINE2"));

// 6. bash: cwd mapping, streaming, exit codes
let out = "";
let res = await bash.exec("pwd && echo from-stderr >&2 && printf nolf", cwd, { onData: (d) => (out += d.toString()) });
check("bash pwd in remote cwd", out.includes(cwd) && res.exitCode === 0, JSON.stringify(out));
check("bash captures stderr", out.includes("from-stderr"));
res = await bash.exec("exit 42", cwd, { onData: () => {} });
check("bash exit code passthrough", res.exitCode === 42, String(res.exitCode));

// 6b. local cwd maps to remote cwd
out = "";
await bash.exec("pwd", process.cwd(), { onData: (d) => (out += d.toString()) });
check("local cwd mapped to remote cwd", out.trim() === cwd, out.trim());

// 7. bash timeout (pi contract: throws Error("timeout:<n>"))
out = "";
const t0 = Date.now();
const timeoutError = await bash.exec("sleep 20", cwd, { onData: (d) => (out += d.toString()), timeout: 1 }).then(() => null, (e) => e);
check("bash timeout throws timeout:<n>", Date.now() - t0 < 5000 && timeoutError?.message === "timeout:1" && out.includes("timed out"), `${Date.now() - t0}ms err=${timeoutError?.message}`);

// 8. abort signal (pi contract: throws Error("aborted"))
const controller = new AbortController();
setTimeout(() => controller.abort(), 300);
const t1 = Date.now();
const abortError = await bash.exec("sleep 20", cwd, { onData: () => {}, signal: controller.signal }).then(() => null, (e) => e);
check("bash abort throws aborted", Date.now() - t1 < 5000 && abortError?.message === "aborted", `${Date.now() - t1}ms err=${abortError?.message}`);

// 8b. atomic write: overwrite an existing file, content + mode preserved
const target = path.join(cwd, "atomic.txt");
await write.writeFile(target, "v1\n");
fs.chmodSync(target, 0o751);
await write.writeFile(target, "v2\n");
const mode = fs.statSync(target).mode & 0o777;
check("atomic overwrite keeps content", (await read.readFile(target)).toString() === "v2\n");
check("atomic overwrite keeps mode", mode === 0o751, mode.toString(8));
check("no temp files left behind", !fs.readdirSync(cwd).some((f) => f.includes(".pi-tmp-")), fs.readdirSync(cwd).join(","));

// 8c. windows-style drive-letter path is normalized
const winStyle = `C:${cwd.replaceAll("/", "\\")}\\hello.txt`;
check("win32 drive-letter path normalized", (await read.readFile(winStyle)).toString() === "hello remote\n");

// 9. image mime sniffing (PNG magic bytes)
const png = path.join(cwd, "img.png");
await write.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("latin1"));
fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
check("detect png mime", (await read.detectImageMimeType!(png)) === "image/png");
check("non-image mime -> null", (await read.detectImageMimeType!(tricky)) === null);

// 10. parallel ops over one connection
const results = await Promise.all(Array.from({ length: 8 }, () => read.readFile(path.join(cwd, "hello.txt"))));
check("8 parallel reads", results.every((buffer) => buffer.toString() === "hello remote\n"));

// 11. transparent reconnect after dropped connection
server.dropConnections();
await new Promise((resolve) => setTimeout(resolve, 200));
const reread = await read.readFile(path.join(cwd, "hello.txt"));
check("auto-reconnect after drop", reread.toString() === "hello remote\n", `states: ${states.join(",")}`);

// 12. wrong password -> friendly auth error, no retry storm
const badRemote = new RemoteConnection({ ...projectRef, server: { ...projectRef.server, password: "wrong" } });
const authError = await new RemoteFsRouter(badRemote).resolveProjectCwd().then(() => null, (e) => e);
check("auth failure is friendly + fail-closed", authError?.kind === "auth" && authError?.retryable === false, authError?.message?.slice(0, 70));
badRemote.dispose();

// 13. missing project path -> friendly remote-path error
const badPath = new RemoteConnection({ ...projectRef, project: { title: "x", path: "no-such-dir" } });
const pathError = await new RemoteFsRouter(badPath).resolveProjectCwd().then(() => null, (e) => e);
check("missing project path error", pathError?.kind === "remote-path", pathError?.message?.slice(0, 80));
badPath.dispose();

// 14. host key pinning: restart server with a DIFFERENT host key
remote.dispose();
server.close();
await new Promise((resolve) => setTimeout(resolve, 200));
server = await startServer({ port: PORT, hostKeyPath: HOSTKEY2, sandbox: SANDBOX });
const pinned = new RemoteConnection(projectRef);
const hostKeyError = await new RemoteFsRouter(pinned).resolveProjectCwd().then(() => null, (e) => e);
check("host key mismatch fails closed", hostKeyError?.kind === "host-key", hostKeyError?.message?.slice(0, 80));
pinned.dispose();
server.close();
await new Promise((resolve) => setTimeout(resolve, 200));

// --- 15+. shell fallback suite: server refuses the SFTP subsystem ---
// (emulates jailed shared hosting, e.g. "exit code 254 while establishing SFTP session")
try {
	const hosts = JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, "utf8"));
	delete hosts[`127.0.0.1:${PORT}`];
	fs.writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(hosts, null, "\t"));
} catch {}
server = await startServer({ port: PORT, hostKeyPath: HOSTKEY, sandbox: SANDBOX, disableSftp: true });
const shRemote = new RemoteConnection(projectRef);
const shRouter = new RemoteFsRouter(shRemote);
let fellBack = "";
shRouter.onFallback = (reason) => (fellBack = reason);

const shCwd = await shRouter.resolveProjectCwd();
check("shell fallback: resolve project path", shCwd === fs.realpathSync(PROJECT_DIR), shCwd);
check("shell fallback: fallback notice fired", fellBack.length > 0, fellBack.slice(0, 70));

const shRead = createRemoteReadOps(shRouter);
const shWrite = createRemoteWriteOps(shRouter);
check("shell fallback: read", (await shRead.readFile(path.join(shCwd, "hello.txt"))).toString() === "hello remote\n");

const shMissing = await shRead.readFile(path.join(shCwd, "nope.txt")).then(() => null, (e) => e);
check("shell fallback: ENOENT", shMissing?.code === "ENOENT", shMissing?.message);

const shDir = path.join(shCwd, "sh/x y");
await shWrite.mkdir(shDir);
const shFile = path.join(shDir, "file with 'quotes'.txt");
await shWrite.writeFile(shFile, "caf\u00e9 \u00fc\u00df \u2713\n");
check("shell fallback: utf8 write/read roundtrip", (await shRead.readFile(shFile)).toString() === "caf\u00e9 \u00fc\u00df \u2713\n");

// binary safety on the read path: bash creates random bytes, readFile must match
const shBash = createRemoteBashOps(shRemote, process.cwd());
let shMd5 = "";
await shBash.exec(`head -c 4096 /dev/urandom > ${JSON.stringify(shDir)}/bin.dat && md5sum ${JSON.stringify(shDir)}/bin.dat | cut -d' ' -f1`, shCwd, { onData: (d) => (shMd5 += d.toString()) });
const shBin = await shRead.readFile(`${shDir}/bin.dat`);
check("shell fallback: binary read matches md5", shMd5.trim() === createHash("md5").update(shBin).digest("hex"), `${shBin.length} bytes`);

const shTarget = path.join(shCwd, "sh-atomic.txt");
await shWrite.writeFile(shTarget, "v1\n");
fs.chmodSync(shTarget, 0o741);
await shWrite.writeFile(shTarget, "v2\n");
check("shell fallback: atomic overwrite keeps content", (await shRead.readFile(shTarget)).toString() === "v2\n");
check("shell fallback: atomic overwrite keeps mode", (fs.statSync(shTarget).mode & 0o777) === 0o741, (fs.statSync(shTarget).mode & 0o777).toString(8));
check("shell fallback: no temp files left", !fs.readdirSync(shCwd).some((f) => f.includes(".pi-tmp-")));

const shBadPath = new RemoteConnection({ ...projectRef, project: { title: "x", path: "no-such-dir" } });
const shPathError = await new RemoteFsRouter(shBadPath).resolveProjectCwd().then(() => null, (e) => e);
check("shell fallback: missing project path error", shPathError?.kind === "remote-path", shPathError?.message?.slice(0, 80));
shBadPath.dispose();
shRemote.dispose();

// cleanup pin + server
try {
	const hosts = JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, "utf8"));
	delete hosts[`127.0.0.1:${PORT}`];
	fs.writeFileSync(KNOWN_HOSTS_PATH, JSON.stringify(hosts, null, "\t"));
} catch {}
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
