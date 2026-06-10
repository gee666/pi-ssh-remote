// Minimal SSH server (auth + exec + SFTP subset) used to integration-test
// the extension's client stack without any external sshd.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export function startServer(options: { port: number; hostKeyPath: string; sandbox: string; disableSftp?: boolean }): Promise<{ close: () => void; dropConnections: () => void }> {
	const clients = new Set<import("ssh2").Connection>();
	const server = new Server({ hostKeys: [fs.readFileSync(options.hostKeyPath)] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			if (ctx.method === "password" && ctx.username === "test" && ctx.password === "testpass") ctx.accept();
			else if (ctx.method === "none") ctx.reject(["password"]);
			else ctx.reject(["password"]);
		});
		client.on("ready", () => {
			client.on("session", (acceptSession) => {
				const session = acceptSession();
				session.on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec();
					// Real sshd starts exec commands in the user's home directory.
					const child = spawn("bash", ["-c", info.command], { cwd: options.sandbox });
					stream.pipe(child.stdin);
					child.stdin.on("error", () => {});
					child.stdout.pipe(stream, { end: false });
					child.stderr.pipe(stream.stderr, { end: false });
					child.on("close", (code) => {
						stream.exit(code ?? 1);
						stream.end();
					});
					stream.on("close", () => child.kill());
				});
				session.on("sftp", (acceptSftp, rejectSftp) => {
					if (options.disableSftp) {
						// Emulate jailed shared hosting where the sftp subsystem fails.
						rejectSftp();
						return;
					}
					const sftp = acceptSftp();
					const handles = new Map<number, number>();
					let nextHandle = 1;
					const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(options.sandbox, p));
					const attrsFor = (stats: fs.Stats) => ({ mode: stats.mode, uid: stats.uid, gid: stats.gid, size: stats.size, atime: stats.atimeMs / 1000, mtime: stats.mtimeMs / 1000 });
					const fail = (reqid: number, error: NodeJS.ErrnoException) => {
						const code = error.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : error.code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
						sftp.status(reqid, code);
					};
					sftp.on("REALPATH", (reqid, p) => {
						const resolved = resolvePath(p);
						if (!fs.existsSync(resolved)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
						sftp.name(reqid, [{ filename: fs.realpathSync(resolved), longname: "", attrs: {} as never }]);
					});
					const statHandler = (reqid: number, p: string) => {
						try {
							sftp.attrs(reqid, attrsFor(fs.statSync(resolvePath(p))) as never);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					};
					sftp.on("STAT", statHandler);
					sftp.on("LSTAT", statHandler);
					sftp.on("OPEN", (reqid, filename, flags) => {
						try {
							const fd = fs.openSync(resolvePath(filename), utils.sftp.flagsToString(flags) ?? "r");
							const id = nextHandle++;
							handles.set(id, fd);
							const handle = Buffer.alloc(4);
							handle.writeUInt32BE(id, 0);
							sftp.handle(reqid, handle);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					});
					sftp.on("FSTAT", (reqid, handle) => {
						const fd = handles.get(handle.readUInt32BE(0));
						if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
						sftp.attrs(reqid, attrsFor(fs.fstatSync(fd)) as never);
					});
					sftp.on("READ", (reqid, handle, offset, length) => {
						const fd = handles.get(handle.readUInt32BE(0));
						if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
						const buffer = Buffer.alloc(length);
						const bytes = fs.readSync(fd, buffer, 0, length, offset);
						if (bytes === 0) return sftp.status(reqid, STATUS_CODE.EOF);
						sftp.data(reqid, buffer.subarray(0, bytes));
					});
					sftp.on("WRITE", (reqid, handle, offset, data) => {
						const fd = handles.get(handle.readUInt32BE(0));
						if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
						fs.writeSync(fd, data, 0, data.length, offset);
						sftp.status(reqid, STATUS_CODE.OK);
					});
					sftp.on("CLOSE", (reqid, handle) => {
						const id = handle.readUInt32BE(0);
						const fd = handles.get(id);
						if (fd !== undefined) {
							fs.closeSync(fd);
							handles.delete(id);
						}
						sftp.status(reqid, STATUS_CODE.OK);
					});
					sftp.on("MKDIR", (reqid, p) => {
						try {
							fs.mkdirSync(resolvePath(p));
							sftp.status(reqid, STATUS_CODE.OK);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					});
					sftp.on("RENAME", (reqid, from, to) => {
						try {
							// Emulate strict SFTP v3 semantics: refuse to overwrite.
							if (fs.existsSync(resolvePath(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
							fs.renameSync(resolvePath(from), resolvePath(to));
							sftp.status(reqid, STATUS_CODE.OK);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					});
					sftp.on("REMOVE", (reqid, p) => {
						try {
							fs.unlinkSync(resolvePath(p));
							sftp.status(reqid, STATUS_CODE.OK);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					});
					sftp.on("SETSTAT", (reqid, p, attrs) => {
						try {
							if (attrs.mode !== undefined) fs.chmodSync(resolvePath(p), attrs.mode);
							sftp.status(reqid, STATUS_CODE.OK);
						} catch (error) {
							fail(reqid, error as NodeJS.ErrnoException);
						}
					});
				});
			});
		});
	});
	server.on("connection", (client) => {
		clients.add(client);
		client.on("close", () => clients.delete(client));
	});
	return new Promise((resolve) => {
		server.listen(options.port, "127.0.0.1", () => {
			resolve({
				close: () => server.close(),
				dropConnections: () => {
					for (const client of clients) client.end();
				},
			});
		});
	});
}
