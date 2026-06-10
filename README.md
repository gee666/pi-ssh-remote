# pi ssh remote

`oira666_pi-ssh-remote` is a pi extension that makes the built-in `read`, `write`, `edit`, and `bash` tools operate on a remote SSH project instead of the local filesystem. The agent works as if it were running natively on the remote server.

The extension is intentionally inert unless pi is started with `--ssh-remote` (or `PI_CODING_AGENT_SSH_REMOTE_PROJECT` is set).

## How it works

- One **persistent SSH connection** per session (pure-JS [`ssh2`](https://www.npmjs.com/package/ssh2)), with keepalives and automatic reconnection with backoff. No per-command handshakes.
- **File operations use SFTP** — binary-safe, no shell quoting, real `ENOENT`/`EACCES` errors. Writes are atomic (temp file + rename, preserving file mode), so a dropped connection can never leave a truncated file.
- **Automatic shell fallback when SFTP is blocked**: some jailed/shared-hosting servers refuse the SFTP subsystem (for example “exit code 254 while establishing SFTP session”). The extension detects this and transparently switches file operations to plain exec channels (`cat`, `mv`, `mkdir`) — still binary-safe, still atomic writes, no behavior change for the agent.
- **Bash commands run over exec channels** with live output streaming, real remote exit codes, timeout and Ctrl-C/abort support.
- **Nothing is installed on the remote host.** A standard sshd with the SFTP subsystem (enabled by default everywhere) and `bash` is all that is required. No agents, no helpers, no node.
- **No local external binaries either** — no `ssh` or `sshpass` needed. Works identically from Linux, macOS, WSL, and native Windows.
- **Host key pinning (trust-on-first-use)**: fingerprints are stored in `~/.pi/agent/ssh-remote-known-hosts.json`; a changed host key fails closed with instructions.

## Installation

```bash
pi install npm:oira666_pi-ssh-remote
```

## Usage

```bash
pi --ssh-remote
```

Select a configured project explicitly:

```bash
pi --ssh-remote --ssh-remote-project "My project"
```

`--ssh-remote-project` accepts a project title, server name, project path, or 1-based index. In non-UI modes, either configure exactly one project, pass `--ssh-remote-project`, or set `PI_CODING_AGENT_SSH_REMOTE_PROJECT`.

For subprocesses and subagents, the extension exports the selected project as:

```bash
PI_CODING_AGENT_SSH_REMOTE_PROJECT='server-name::/exact/remote/project/path'
```

This variable also selects and enables a project when starting pi yourself. The canonical format is `server-name::project-path`. JSON is also accepted for scripting, for example `{"serverName":"server-name","projectPath":"/exact/path"}`. Simple selectors (title, server name, path, label, 1-based index) are accepted too.

In non-interactive modes (including `-p` / `--print`), the project must be unambiguous: a single configured project, `--ssh-remote-project`, or `PI_CODING_AGENT_SSH_REMOTE_PROJECT`. If it is ambiguous, the extension fails closed with a clear error instead of silently working on the local filesystem.

## Configuration

Create `~/.pi/agent/ssh-remote-config.json`:

```json
{
  "my-server": {
    "hostName": "example.com",
    "user": "deploy",
    "port": 22,
    "identityFile": "~/.ssh/id_ed25519",
    "projects": [
      { "title": "My project", "path": "/var/www/app" }
    ]
  }
}
```

Each top-level key is a server name. Fields (OpenSSH-style aliases accepted):

- `host` / `hostName` — defaults to the server name itself
- `user`, `port`
- `identityFile` — path to a private key (`~` is expanded)
- `passphrase` / `passphraseEnv` — for encrypted private keys
- `password` / `passwordEnv` — password authentication, built in, no `sshpass` needed; prefer `passwordEnv` to keep secrets out of the file
- `projects`: array of `{ "title": string, "path": string }`

Project paths may be **absolute** (`/var/www/app`) or **relative to the remote home directory** (`www/app`). Absolute paths are recommended: they let pi start even while the server is temporarily unreachable.

If neither `identityFile` nor a password is configured, the extension uses your SSH agent (`SSH_AUTH_SOCK`; on Windows, the OpenSSH agent named pipe).

Password example without storing the secret:

```json
{
  "example": {
    "hostName": "example.com",
    "user": "deploy",
    "passwordEnv": "MY_SSH_PASSWORD",
    "projects": [{ "title": "App", "path": "/var/www/app" }]
  }
}
```

```bash
MY_SSH_PASSWORD='secret' pi --ssh-remote
```

## Behavior

When enabled, the extension selects a project (prompting in UI mode), connects once to verify access and resolve the project directory, registers remote-backed `read`, `write`, `edit`, and `bash` tools, routes user `!` shell commands over SSH, and rewrites the system prompt so the agent sees the remote project directory as its working directory.

Connection lifecycle:

- The connection stays open for the whole session and sends keepalives.
- If it drops, the next operation transparently reconnects (with backoff) and retries the operation once. File operations are safe to retry; **bash commands are never silently rerun** — if the connection drops mid-command, the tool reports exactly that, including a warning that the command may or may not have completed.
- If the server is unreachable at startup but the project path is absolute, pi stays open and reconnects when the server is back.

If setup fails, the extension registers replacement tools that **refuse every operation** with the setup error — the agent can never silently fall back to the local filesystem. Fail-closed setup errors include:

- invalid or missing config / project selector
- unreadable or unparsable private key (with a passphrase hint when relevant)
- unset `passwordEnv` / `passphraseEnv` variable
- authentication failure
- changed host key (pinned fingerprint mismatch)
- DNS failure / unknown host
- missing or non-directory remote project path

## Remote requirements

A standard SSH server, plus `bash` for shell commands. The SFTP subsystem is used when available; when it is not (jailed shells, restricted shared hosting), file operations automatically fall back to POSIX shell commands over exec channels. Nothing is installed or written outside your project directory.

## Development

```bash
npm run typecheck   # strict TS, no emit
npm test            # integration tests against an in-process ssh2 server
```

The test suite (`test/test-integration.ts`) spins up a local SSH server (auth + SFTP + exec) and exercises connect, relative path resolution, file round-trips with awkward filenames, binary safety, exit codes, timeouts, aborts, parallel operations, automatic reconnection, and host-key pinning — no network or credentials required.
