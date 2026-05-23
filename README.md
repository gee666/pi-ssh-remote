# pi ssh remote

`oira666_pi-ssh-remote` is a pi extension that makes the built-in `read`, `write`, `edit`, and `bash` tools operate on a selected SSH project instead of the local filesystem.

The extension is intentionally inert unless pi is started with `--ssh-remote`.

## Usage

```bash
pi -e . --ssh-remote
```

In print/non-UI mode, either configure exactly one project or select one explicitly:

```bash
pi -ne -e . --ssh-remote --ssh-remote-project "My project" -p "pwd"
```

`--ssh-remote-project` accepts a project title, server name, project path, or 1-based index. You can also set `PI_SSH_REMOTE_PROJECT` or `SSH_REMOTE_PROJECT`.

## Configuration

Create `~/.pi/agent/ssh-remote-config.json`:

```json
{
  "artlin6-dance": {
    "hostName": "205.134.255.228",
    "user": "artlin6",
    "port": 2222,
    "identityFile": "~/.ssh/dance_alchemy_key",
    "identitiesOnly": true,
    "projects": [
      {
        "title": "Safe temp project",
        "path": "/tmp/pi-ssh-remote-test"
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
- `identitiesOnly` / `IdentitiesOnly`
- `sshOptions` object for additional `-o key=value` options
- `projects`: array of `{ "title": string, "path": string }`

If `host` is omitted, the server name is used as the SSH target, which works well with entries in `~/.ssh/config`.

## Behavior

When `--ssh-remote` is not set, the extension only registers its flags and does not override any tools.

When enabled, pi prompts for a configured project in UI mode, checks the local SSH client/key, probes the remote connection and project directory, registers remote-backed replacements for `read`, `write`, `edit`, and `bash`, routes user `!` shell commands over SSH, and rewrites the system prompt working directory to the remote project path.

The extension fails closed: if config, authentication, host-key verification, network access, or the remote project path is invalid, pi displays a readable red error and does not let the agent continue as if it were connected.

## Error handling

The extension classifies common SSH failures into actionable messages:

- missing local `ssh` command
- unreadable `IdentityFile`
- authentication/public-key failure
- host-key verification failure
- DNS/host typo
- connection refused or timeout
- missing remote project path
- missing required remote commands

Transient SSH operations are retried once. After repeated infrastructure failures, tools stop retrying and report that the remote appears unavailable instead of spamming raw SSH errors.

Remote hosts need `bash`, `cat`, `mkdir`, and `test` available.
