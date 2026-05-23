# pi ssh remote

`oira666_pi-ssh-remote` is a pi extension that makes the built-in `read`, `write`, `edit`, and `bash` tools operate on a selected SSH project instead of the local filesystem.

The extension is intentionally inert unless pi is started with `--ssh-remote`.

## Installation

```bash
pi install npm:oira666_pi-ssh-remote
```

## Usage

Start pi in SSH remote mode:

```bash
pi --ssh-remote
```

Select a configured project explicitly:

```bash
pi --ssh-remote --ssh-remote-project "My project"
```

`--ssh-remote-project` accepts a project title, server name, project path, or 1-based index. In non-UI modes that are not inline/print mode, either configure exactly one project, pass `--ssh-remote-project`, or set `PI_CODING_AGENT_SSH_REMOTE_PROJECT`.

For subprocesses and subagents, the extension exports the selected project as:

```bash
PI_CODING_AGENT_SSH_REMOTE_PROJECT='server-name::/exact/remote/project/path'
```

This variable also selects and enables a project when starting pi yourself. The canonical format is `server-name::project-path`, where `server-name` is the top-level key in `ssh-remote-config.json` and `project-path` is the exact configured project path. JSON is also accepted for scripting, for example `{"serverName":"server-name","projectPath":"/exact/path"}`. For backwards compatibility, simple selectors such as project title, server name, path, label, or 1-based index are accepted too.

If pi is launched in inline/print mode (`-p` / `--print`), the extension ignores `--ssh-remote` by itself so inherited command-line arguments do not trigger an interactive picker or fail in non-interactive children. In print mode, remote mode is enabled only when `PI_CODING_AGENT_SSH_REMOTE_PROJECT` is set.

## Configuration

Create `~/.pi/agent/ssh-remote-config.json`:

```json
{
  "artlin6-dance": {
    "hostName": "<your host>",
    "user": "<your user>",
    "port": <ssh port>,
    "identityFile": "<path to the ssh key file>",
    "identitiesOnly": true,
    "projects": [
      {
        "title": "Your project title",
        "path": "/remote/project/path"
      }
    ]
  }
}
```

Each top-level key is a server name. Server fields can use SSH config aliases or explicit settings:

- `host` / `Host` / `hostName` / `HostName`
- `user` / `User`
- `port` / `Port`
- `identityFile` / `IdentityFile`
- `password` / `Password` (requires local `sshpass`; prefer `passwordEnv`)
- `passwordEnv` / `PasswordEnv` (name of an environment variable containing the password; requires local `sshpass`)
- `identitiesOnly` / `IdentitiesOnly`
- `sshOptions` object for additional `-o key=value` options
- `projects`: array of `{ "title": string, "path": string }`

If `host` is omitted, the server name is used as the SSH target, which works well with entries in `~/.ssh/config`.

Password authentication is supported when `sshpass` is installed locally. To avoid storing a password in the config file, use `passwordEnv`:

```json
{
  "example": {
    "hostName": "example.com",
    "user": "deploy",
    "passwordEnv": "PI_CODING_AGENT_SSH_REPOTE_PASSWORD",
    "projects": [{ "title": "App", "path": "/var/www/app" }]
  }
}
```

Then start pi with `PI_CODING_AGENT_SSH_REPOTE_PASSWORD='your password' pi --ssh-remote`. Host-key verification still applies; connect once manually with `ssh example.com` if the host is not in `known_hosts` yet.

## Behavior

When `--ssh-remote` is not set and `PI_CODING_AGENT_SSH_REMOTE_PROJECT` is not set, the extension only registers its flags and does not override any tools.

When enabled, pi prompts for a configured project in UI mode, checks the local SSH client and configured key/password prerequisites, probes the remote connection and project directory, exports `PI_CODING_AGENT_SSH_REMOTE_PROJECT` for child processes, registers remote-backed replacements for `read`, `write`, `edit`, and `bash`, routes user `!` shell commands over SSH, and rewrites the system prompt working directory to the remote project path.

The extension fails closed: if config, authentication, host-key verification, network access, or the remote project path is invalid, pi displays a readable red error and does not let the agent continue as if it were connected.

## Error handling

The extension classifies common SSH failures into actionable messages:

- missing local `ssh` command
- missing local `sshpass` command when password auth is configured
- unset password environment variable
- unreadable `IdentityFile`
- authentication/public-key/password failure
- host-key verification failure
- DNS/host typo
- connection refused or timeout
- missing remote project path
- missing required remote commands

Transient SSH operations are retried once. After repeated infrastructure failures, tools stop retrying and report that the remote appears unavailable instead of spamming raw SSH errors.

Remote hosts need `bash`, `cat`, `mkdir`, and `test` available.
