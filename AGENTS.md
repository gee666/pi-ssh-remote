# Project instructions

## Pi compatibility and releases

- Test only against the latest stable Pi release from npm. Do not add a minimum-version test matrix or rely on stale installed dependencies.
- Run `npm test` before every release. Its `pretest` installs the latest `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, then runs strict typechecking. The tests use an in-process SSH server, not a production host.
- After successful checks, add or update the standalone README line `Tested against Pi <version>` using the actual installed coding-agent version. Never claim a version that was not tested. Keep this line current on every release and include it in the release commit.
- Declare host-provided Pi libraries as peer dependencies, not runtime dependencies. Keep supported Pi version ranges accurate in `package.json`; they state compatibility, not an automatic update policy. Keep local development dependencies and the lockfile aligned with the tested release.
- Keep this root `AGENTS.md` tracked and committed. Do not bump versions, publish packages, or push releases unless requested.

## Code quality bar

- Remove dead code, unused imports, and unused dependencies. Wire intended functionality into the extension instead of leaving disconnected code.
- Keep SSH transport, remote filesystem operations, tool registration, configuration, and TUI responsibilities separate. Follow existing TypeScript, Node.js, and `ssh2` conventions and Pi's documented extension contracts.
- Avoid duplicated logic and unnecessary abstractions. Prefer simple, consistent solutions over one-off patterns.
- Fix root causes, not symptoms. Avoid brittle workarounds. Make deployment-specific values and operational settings configurable. Never hardcode secrets, log credentials, weaken host-key verification, or silently fall back to local execution after a remote setup failure.
- Use strict TypeScript and types that model valid application states. Validate configuration, SSH responses, paths, and other external data at runtime. Do not bypass type safety with `any`, unsafe assertions, or suppressed type errors.
- Keep functions and classes focused. Split files by responsibility before they exceed 350 lines. Exceed this limit only when splitting would clearly hurt readability or cohesion, and explain why. Avoid unrelated restructuring during maintenance changes.
- Remove stale or irrelevant comments and docs. Keep useful ones accurate, short, clear, and human-friendly. Explain non-obvious decisions rather than restating code. Apply the unslop and write-prompts skills when available.
- Add or update tests for changed behavior, including cancellation, reconnection, path handling, and fail-closed behavior when affected. Run the available type checks, lint checks, and relevant tests before considering work complete. This project currently has no lint script; do not claim a lint check was run.
- Give every shell command a timeout. Keep temporary investigation files and test logs in the project's `tmp/` directory.
