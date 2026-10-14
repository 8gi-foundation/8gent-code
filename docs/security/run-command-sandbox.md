# run_command OS sandbox and Bun launch hygiene (#4009, #4013)

## The boundary

`packages/permissions/run-command-sandbox.ts` wraps every `run_command` and `background_start` child in an allow-default macOS Seatbelt profile. The profile denies writes, links, renames and metadata changes to 8gent's startup code, secrets and records under `~/.8gent`, under `EIGHT_HOME/.8gent` and under `EIGHT_DATA_DIR`. Reads are still allowed.

| Platform | Mechanism | When it is off |
|----------|-----------|----------------|
| macOS | Seatbelt (`sandbox-exec`), on by default | `EIGHT_SEATBELT=0`, or the host already sandboxes the process |
| Linux | bubblewrap read-only binds of the protected paths that exist | `bwrap` missing or unable to create a namespace |
| Windows | none | always |

A command never runs without the boundary silently:

- It prints one stderr warning per process.
- It writes a line to `<data root>/audit/run-command-sandbox.jsonl`.
- The TUI footer shows `sandbox off <reason>`.

`EIGHT_SEATBELT=require` refuses to run a command that cannot be sandboxed.

## Security env

`EIGHT_SEATBELT`, `EIGHT_DATA_DIR`, `EIGHT_HOME` and `HOME` are read once, when the module loads. A key that any `.env` file Bun or 8gent could load declares is ignored, whatever its value. The one exception is `EIGHT_SEATBELT=require`, which is always kept. `EIGHT_FAKE_HOME` only works under `NODE_ENV=test` or `BUN_ENV=test`, and those values must not come from a `.env` file.

## Bun never reads a cwd bunfig.toml or .env

A `bunfig.toml` `preload` in a workspace would run code before the snapshot, and a `.env` file there would set keys. Every Bun process 8gent starts is protected in one of these ways:

- **Spawned children:** `--no-env-file --config=<empty>` via `safeBunFlags()` in `packages/core/bun-flags.ts`.
- **npm and shell launchers:** the same two flags with the shipped empty `bin/bunfig.empty.toml`.
- **Directly executed entry points:** the shebang `#!/usr/bin/env -S bun --no-install --no-env-file --config=/dev/null`.
- **Compiled binaries:** built with `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`.

`tests/security/launcher-cwd-config.test.ts` fails if any spawn of `bun` or `process.execPath` in the repo is missing the flags.

**`env -S` needs GNU coreutils 8.30 or newer, or BSD/macOS `env`.** BusyBox `env` has no `-S`. On BusyBox an entry point run directly through its shebang therefore fails to start with an `env` usage error. It never runs without the flags, so it fails closed. Start 8gent through `8gent` (bin/8gent-run.js) or `bin/8gent-cli.sh` there; both pass the flags explicitly.
