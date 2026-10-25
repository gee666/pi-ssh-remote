## Summary
- Make Pi work on an SSH project as if running there, with nothing installed remotely.
- Core tools and user `!` commands route remotely; local access is explicit opt-in.
- Advertised skills and supporting files remain locally readable in SSH mode.
- Uses public extension hooks, tool factories/operations, and TUI components.
- No internal Pi APIs or private/deep Pi imports are used.
- Main risks: cwd binding, fail-closed setup, switching, transport loss, and prompt drift.

## Intent
Start locally unless an SSH flag or inherited project requests remote execution.
Keep conversation context when switching servers/directories; failed or cancelled
switches keep the previous location. Reuse connections, pin host keys, write
atomically, reconnect file operations, and never silently rerun bash commands.
Mixed modes must keep local and remote namespaces distinct. Subprocesses inherit
`PI_CODING_AGENT_SSH_REMOTE_PROJECT`, not mixed-mode local-access permissions.

## Pi integration (public APIs)
`ExtensionAPI`: flags, commands, tool registration/activation, custom messages.
Hooks: `session_start`, `session_shutdown`, `before_agent_start`, `user_bash`.
Exported read/write/edit/bash factories accept SSH operation adapters; exported
search factories supply local mixed-mode tools. Tool execution context cwd is
explicitly rebound for remote tools, since Pi otherwise supplies its local cwd.
`systemPromptOptions.skills` identifies local skill paths. UI uses dialogs,
notifications, title, and a connected-only widget below the editor; path/import
pickers use public pi-tui components, input helpers, and keybindings.

## Internal Pi APIs
None. No private imports, Pi source patching, or undocumented runtime access.
Prompt cwd replacement does depend on Pi's generated prompt wording, not an API.

## Weak points
Pi prompt formatting and tool execution/schema changes can break remote intent.
SSH/SFTP differences, shell quoting, Windows paths, atomic rename semantics,
timeouts, host-key persistence, and reconnect races need regression coverage.
Remote grep/find require rg/fd; plain SSH needs only SSH and bash.
Interactive picker rendering and real restricted hosting are not CLI-e2e covered.

## Tests
`npm run test:evergreen` updates Pi dev libraries to latest, typechecks, then runs
unit, integration, and live installed-Pi e2e tests. Requires ssh-keygen, bash,
registry access, provider credentials, and `EVERGREEN_E2E_MODEL` (provider/model).
E2E uses `EVERGREEN_PI_BIN` or `pi` on PATH, stdin ignored, saved sessions,
isolated config/home, and a loopback SSH server; credentials/catalog are copied
from `PI_CODING_AGENT_DIR` or ~/.pi/agent and removed after the test.
Unit tests protect config selection/import, skills, search, and picker behavior.
Mode/lifecycle integration tests protect activation, switching without context
loss, connection reuse, local opt-in, inherited selection, and fail-closed setup.
Transport integration covers atomic/binary I/O, SFTP fallback, reconnect, auth,
host keys, cancellation, and exit codes. Tool-workflow integration joins actual
Pi factories to SSH and checks the local-skill exception and project isolation.
E2E requires model-issued read/write/edit/bash calls in inherited SSH and
local-first modes, verifies a remote-only nonce and resulting files, and ensures
the local launch directory stays untouched. Tested with installed Pi 1.4.0.

## Relevant changelog topics
Tool factory context/cwd and execution contracts; dynamic tool activation;
user_bash operations; session startup/shutdown; prompt sections and skill metadata;
custom message ordering; RPC dialogs, TUI input/keybindings, and widget placement.
