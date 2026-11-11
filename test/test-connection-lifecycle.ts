import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import type { Client, ConnectConfig, Connection } from "ssh2";
import type { RemoteProject } from "../src/config.ts";

// Keep TOFU writes away from the user's real known-hosts file.
await mkdir("tmp", { recursive: true });
const home = await mkdtemp(path.resolve("tmp/connection-lifecycle-"));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { RemoteConnection } = await import("../src/connection.ts");
after(async () => {
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
	await rm(home, { recursive: true, force: true });
});

function remoteFor(t: TestContext, port: number) {
	const project: RemoteProject = {
		serverName: "lifecycle-test",
		server: { host: "127.0.0.1", port, user: "test", password: "wrong" },
		project: { title: "Test", path: "." },
		label: "Test",
	};
	const remote = new RemoteConnection(project);
	t.after(() => remote.dispose());
	return remote;
}

function observeClients(t: TestContext, afterConnect?: () => void) {
	const attempts: { client: Client; closed: boolean }[] = [];
	const connect = ssh2.Client.prototype.connect;
	t.mock.method(ssh2.Client.prototype, "connect", function (this: Client, config: ConnectConfig) {
		const attempt = { client: this, closed: false };
		attempts.push(attempt);
		this.once("close", () => { attempt.closed = true; });
		const result = connect.call(this, config);
		afterConnect?.();
		return result;
	});
	return attempts;
}

async function waitFor(predicate: () => boolean, message: string, timeout = 1_000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await delay(5);
	}
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("operation did not settle promptly")), 250);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}

async function heldServer(t: TestContext, onData?: (socket: net.Socket) => void) {
	const sockets: net.Socket[] = [];
	// Do not answer the SSH greeting or close our write side on EOF. A client
	// calling only end() will linger here, so client close events matter too.
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		socket.once("data", () => onData?.(socket));
		socket.resume();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { port: (server.address() as net.AddressInfo).port, sockets };
}

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
async function authServer(t: TestContext, hold: boolean) {
	const clients = new Set<Connection>();
	let passwords = 0;
	const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
		clients.add(client);
		client.on("error", () => {});
		client.on("close", () => clients.delete(client));
		client.on("authentication", (ctx) => {
			if (ctx.method === "password") {
				passwords++;
				if (hold) return;
			}
			ctx.reject(["password"]);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		for (const client of clients) client.end();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { port: (server.address() as net.AddressInfo).port, clients, passwords: () => passwords };
}

async function readyServer(t: TestContext) {
	const clients = new Set<Connection>();
	const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
		clients.add(client);
		client.on("error", () => {});
		client.on("close", () => clients.delete(client));
		client.on("authentication", (ctx) => ctx.accept());
		client.on("ready", () => client.on("session", (accept) => {
			accept().on("sftp", (acceptSftp) => {
				acceptSftp();
			});
		}));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		for (const client of clients) client.end();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { port: (server.address() as net.AddressInfo).port };
}

const timeoutError = () => Object.assign(new Error("Keepalive timeout"), { level: "client-timeout" });
const closedError = { kind: "connection", retryable: false, message: "SSH remote connection has been closed." };

test("dispose during config preparation never starts a client", { timeout: 3_000 }, async (t) => {
	const server = await heldServer(t);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	const rejected = assert.rejects(remote.getSftp(), closedError);
	remote.dispose();
	await promptly(rejected);
	await delay(20);
	assert.equal(attempts.length, 0);
	assert.equal(server.sockets.length, 0);
	await assert.rejects(remote.execChannel("true"), closedError);
});

test("dispose closes a held handshake and rejects all single-flight callers", { timeout: 3_000 }, async (t) => {
	const server = await heldServer(t);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	const rejected = Promise.all([
		assert.rejects(remote.getSftp(), closedError),
		assert.rejects(remote.execChannel("true"), closedError),
	]);
	await waitFor(() => server.sockets.length === 1, "handshake never connected");
	remote.dispose();
	remote.dispose();
	await promptly(rejected);
	await waitFor(() => attempts.every((attempt) => attempt.closed), "pending client did not close");
	await waitFor(() => server.sockets[0].readableEnded, "server did not observe EOF");
	await delay(550);
	assert.equal(attempts.length, 1, "disposed handshake must not retry");
});

test("dispose closes a connection waiting for authentication", { timeout: 3_000 }, async (t) => {
	const server = await authServer(t, true);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	const rejected = assert.rejects(remote.getSftp(), closedError);
	await waitFor(() => server.passwords() === 1, "password authentication never started");
	remote.dispose();
	await promptly(rejected);
	await waitFor(() => attempts[0].closed && server.clients.size === 0, "authenticating connection lingered");
	assert.equal(attempts.length, 1);
});

test("authentication failure stays nonretryable and closes the failed client", { timeout: 3_000 }, async (t) => {
	const server = await authServer(t, false);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	await assert.rejects(remote.getSftp(), { kind: "auth", retryable: false });
	await waitFor(() => attempts[0].closed && server.clients.size === 0, "failed authentication client lingered");
	assert.equal(attempts.length, 1);
});

test("protocol failure destroys the client even when the peer keeps its write side open", { timeout: 3_000 }, async (t) => {
	const server = await heldServer(t, (socket) => socket.write("SSH-1.5-unsupported\r\n"));
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	await assert.rejects(remote.getSftp(), { retryable: false });
	await waitFor(() => attempts[0].closed, "failed handshake left a half-open client");
	assert.equal(attempts.length, 1);
});

test("a synchronous connect throw closes the partially initialized client", { timeout: 3_000 }, async (t) => {
	const server = await heldServer(t);
	const attempts = observeClients(t, () => { throw new Error("test synchronous connect failure"); });
	const remote = remoteFor(t, server.port);
	await assert.rejects(remote.getSftp(), { kind: "unknown", retryable: false });
	await waitFor(() => attempts[0].closed, "client leaked after connect threw");
	assert.equal(attempts.length, 1);
});

test("retryable pre-ready errors close every failed client before retrying", { timeout: 5_000 }, async (t) => {
	const attempts = observeClients(t);
	let previousClosed = true;
	const server = await heldServer(t, () => {
		const attempt = attempts.at(-1)!;
		previousClosed &&= attempts.slice(0, -1).every((item) => item.closed);
		// Inject a transport error while using a real connected socket. ssh2
		// otherwise destroys timeout/reset sockets itself, hiding this leak.
		attempt.client.emit("error", Object.assign(new Error("test transport failure"), { level: "client-socket" }));
	});
	const remote = remoteFor(t, server.port);
	await assert.rejects(remote.getSftp(), { kind: "connection", retryable: true });
	await waitFor(() => attempts.every((attempt) => attempt.closed), "failed retry clients lingered");
	assert.equal(attempts.length, 3, "normal retry count must be preserved");
	assert.ok(previousClosed, "retry started before the previous client closed");
});

test("keepalive timeout rejects shared SFTP opens and reconnects without stale state", { timeout: 5_000 }, async (t) => {
	const server = await readyServer(t);
	let opens = 0;
	const attempts = observeClients(t, () => {
		if (attempts.length === 1) t.mock.method(attempts[0].client, "sftp", function (this: Client) { opens++; return this; });
	});
	const remote = remoteFor(t, server.port);
	const states: string[] = [];
	remote.onStateChange = (state) => states.push(state);
	const rejected = Promise.all([remote.getSftp(), remote.getSftp()].map((pending) => assert.rejects(pending, { retryable: true })));
	await waitFor(() => opens === 1, "SFTP never opened");
	attempts[0].client.emit("error", timeoutError());
	await promptly(rejected);
	assert.equal(remote.isConnected, false);
	assert.ok(remote.lastFailure);
	await waitFor(() => attempts[0].closed, "timed-out client was not destroyed");
	const [first, second] = await promptly(Promise.all([remote.getSftp(), remote.getSftp()]));
	assert.equal(first, second);
	assert.equal(attempts.length, 2);
	attempts[0].client.emit("error", timeoutError());
	assert.equal(remote.isConnected, true, "late events killed the replacement");
	assert.equal(remote.lastFailure, null);
	assert.deepEqual(states, ["connected", "reconnecting", "connected"]);
});

test("a disconnect between ready and publication cannot cache a dead client", { timeout: 5_000 }, async (t) => {
	const server = await readyServer(t);
	const attempts = observeClients(t, () => {
		if (attempts.length === 1) attempts[0].client.once("ready", () => attempts[0].client.emit("end"));
	});
	const remote = remoteFor(t, server.port);
	await remote.getSftp();
	assert.equal(attempts.length, 2);
	assert.equal(remote.isConnected, true);
});

for (const event of [true, false]) {
	test(`exec ${event ? "timeout event" : "callback failure"} never replays a command`, { timeout: 3_000 }, async (t) => {
		const server = await readyServer(t);
		const attempts = observeClients(t);
		const remote = remoteFor(t, server.port);
		await remote.getSftp();
		const exec = t.mock.method(attempts[0].client, "exec", function (this: Client, _command: string, callback: (error: Error) => void) {
			queueMicrotask(() => event ? this.emit("error", timeoutError()) : callback(timeoutError()));
			return this;
		});
		await promptly(assert.rejects(remote.execChannel("append-to-ledger"), { retryable: true }));
		assert.equal(exec.mock.callCount(), 1);
		assert.equal(attempts.length, 1, "failed command triggered a reconnect/replay");
		await remote.getSftp();
		assert.equal(attempts.length, 2, "next operation did not recover");
	});
}

test("a timed-out SFTP mutation is not replayed and its late failure cannot kill recovery", { timeout: 3_000 }, async (t) => {
	const server = await readyServer(t);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	await remote.getSftp();
	let failOld: (error: Error) => void = () => assert.fail("mutation never started");
	let calls = 0;
	const rejected = assert.rejects(remote.withSftp("write", "/file", () => {
		calls++;
		queueMicrotask(() => attempts[0].client.emit("error", timeoutError()));
		return new Promise<void>((_, reject) => { failOld = reject; });
	}), { retryable: true });
	await promptly(rejected);
	await remote.getSftp();
	failOld(timeoutError());
	await delay(10);
	assert.equal(calls, 1);
	assert.equal(remote.isConnected, true);
	assert.equal(attempts.length, 2);
});

test("read-only SFTP work retries once on its replacement transport", { timeout: 3_000 }, async (t) => {
	const server = await readyServer(t);
	const attempts = observeClients(t);
	const remote = remoteFor(t, server.port);
	let calls = 0;
	assert.equal(await remote.withSftp("open", "/file", async () => {
		if (++calls === 1) throw new Error("No response from server");
		return "recovered";
	}), "recovered");
	assert.equal(calls, 2);
	assert.equal(attempts.length, 2);
});

for (const synchronous of [false, true]) {
	test(`dispose ${synchronous ? "from reconnect notification" : "during backoff"} cancels retries`, { timeout: 3_000 }, async (t) => {
		const attempts = observeClients(t);
		const server = await heldServer(t, () => {
			attempts[0].client.emit("error", Object.assign(new Error("test transport failure"), { level: "client-socket" }));
		});
		const remote = remoteFor(t, server.port);
		let reconnecting = false;
		remote.onStateChange = (state) => {
			if (state === "reconnecting") {
				reconnecting = true;
				if (synchronous) remote.dispose();
			}
		};
		const rejected = assert.rejects(remote.getSftp(), closedError);
		await waitFor(() => reconnecting, "retry backoff never started");
		if (!synchronous) {
			await delay(20);
			remote.dispose();
		}
		await promptly(rejected);
		await waitFor(() => attempts[0].closed, "failed client lingered after disposal");
		await delay(550);
		assert.equal(attempts.length, 1, "a new handshake started after disposal");
	});
}
