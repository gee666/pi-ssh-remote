# pi ssh remote

`oira666_pi-ssh-remote` is a pi extension that makes the built-in `read`, `write`, `edit`, and `bash` tools operate on a remote SSH project instead of the local filesystem. The agent works as if it were running natively on the remote server. Available skills are the exception: `read` checks their advertised paths locally first, then falls back to SSH if the local file is absent. This also covers supporting files inside directory skills. Ordinary project reads, writes, edits, and shell commands remain remote.

The extension is inert unless pi starts with `--ssh`, `--ssh-local`, `--ssh-local-first`, or `PI_CODING_AGENT_SSH_REMOTE_PROJECT` set. Mixed local/SSH access requires an explicit startup flag; the environment variable alone keeps the existing SSH-only behavior.

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
pi --ssh
```

### Mixed local and SSH access

Choose one startup mode:

| Startup flag | Default tools | Additional tools | User `!` commands |
| --- | --- | --- | --- |
| `--ssh` | Existing SSH-backed read, write, edit, bash | None | SSH |
| `--ssh-local` | SSH-backed read, write, edit, bash, grep, find, ls | Local versions ending in `-local` | SSH |
| `--ssh-local-first` | Local read, write, edit, bash, grep, find, ls | SSH versions ending in `-ssh` | Local |

```bash
pi --ssh-local        # bash runs remotely; bash-local runs locally
pi --ssh-local-first  # bash runs locally; bash-ssh runs remotely
```

Every mixed-mode tool has the same arguments as its unsuffixed counterpart. For example, `read-local` and `grep-local` access local files in `--ssh-local`; `read-ssh` and `grep-ssh` access remote files in `--ssh-local-first`. Local relative paths use the directory where pi started. Remote paths use the selected SSH project. The system prompt identifies both locations.

Remote `grep` requires `rg` on the server's PATH. Remote `find` requires `fd` supporting `--no-require-git` and `--max-results`. Remote `ls` uses bash builtins. Search tools have a 60-second timeout and truncate output at 50KB. These extra requirements apply only to the mixed-mode search tools, not plain `--ssh`.

The new modes are enabled only by their startup flags, never by a saved session or the inherited project environment variable. Pass only one mode flag. SSH-backed reads retain the local-first exception for advertised skills and their supporting files. Other explicit local tools access the local filesystem normally.

Select a configured project explicitly in any mode:

```bash
pi --ssh --ssh-remote-project "My project"
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
MY_SSH_PASSWORD='secret' pi --ssh
```

## Behavior

All SSH modes select a project, prompting in UI mode, and connect once to verify access and resolve the project directory. Plain `--ssh` registers remote-backed `read`, `write`, `edit`, and `bash`, routes user `!` commands over SSH, and changes the working directory advertised in the system prompt to the remote project. Mixed modes register both tool sets as listed above. `--ssh-local-first` keeps the advertised working directory and user `!` commands local.

Connection lifecycle:

- The connection stays open for the whole session and sends keepalives.
- If it drops, the next operation transparently reconnects (with backoff) and retries the operation once. File operations are safe to retry; **bash commands are never silently rerun** — if the connection drops mid-command, the tool reports exactly that, including a warning that the command may or may not have completed.
- If the server is unreachable at startup but the project path is absolute, pi stays open and reconnects when the server is back.

If setup fails, SSH-backed tools refuse operations with the setup error instead of silently falling back to local files. Advertised local skill reads remain available. In mixed modes, explicit local tools remain usable; with `--ssh-local-first`, unsuffixed tools and user `!` commands continue to run locally. Fail-closed setup errors include:

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

Startup-mode tests verify tool names, activation, local/remote execution, inherited-project behavior, and fail-closed setup. Search-tool tests cover remote paths, quoting, output limits, cancellation, and diagnostics. Search tests use local `rg` and `fd` when available.

The test suite (`test/test-integration.ts`) spins up a local SSH server (auth + SFTP + exec) and exercises connect, relative path resolution, file round-trips with awkward filenames, binary safety, exit codes, timeouts, aborts, parallel operations, automatic reconnection, and host-key pinning — no network or credentials required.
