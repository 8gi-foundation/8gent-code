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

## The read boundary in the kernel (#4890, macOS slice 1)

`EIGHT_OS_READ_BOUNDARY=1` (default off) adds read rules to the same profile, built by `osReadRules()` from the scope `osReadSpec()` in `read-boundary.ts` hands it, so the kernel and the read card judge the same root:

1. `(deny file-read-data)`: no file is read and no folder listed.
2. Allowed back: the workspace root (`EIGHT_WORKSPACE_ROOT`, else the project), the read allowances (system, include and temp folders), `/allow-read` folders, `~/.8gent`, the macOS system folders (`/usr`, `/System`, `/Library`, `/opt`, `/private/etc`, ...), the `PATH` folders (and `lib`, `libexec`, `share` beside a `bin` under a home), `~/.gitconfig` and `~/.config/git`. The folders above the root can be listed by name only.
3. Denied again, last, so nothing above reopens them: the credential stores (`seatbelt.ts` `sensitiveCredentialPaths()` for every home) and, under `~/.8gent`, memory and brain stores, clients, browser state, audit logs, backups, cron, keys, secrets, sessions, tokens, env files and any `.db`, `.pem` or `.key` file, case-insensitively.

Metadata (`stat`, path lookup) stays allowed. When a person approves a command on a card, the outside paths the command names are added for that run; a path the command builds while it runs never is. The lexical boundary stays in front and explains the card.

Not in this slice: the argv runner (`wrapRunCommandArgv`, the built-in git and gh tools), Linux (Landlock or bubblewrap) and Termux. The live proof runs in `.github/workflows/macos-read-boundary.yml`, because `sandbox-exec` cannot nest inside a sandboxed session.

## Security env

`EIGHT_SEATBELT`, `EIGHT_OS_READ_BOUNDARY`, `EIGHT_DATA_DIR`, `EIGHT_HOME` and `HOME` are read once, when the module loads. A key that any `.env` file Bun or 8gent could load declares is ignored, whatever its value. The exceptions are `EIGHT_SEATBELT=require` and `EIGHT_OS_READ_BOUNDARY=1`, which are always kept: each can only make the boundary stricter. `EIGHT_FAKE_HOME` only works under `NODE_ENV=test` or `BUN_ENV=test`, and those values must not come from a `.env` file.

## Bun never reads a cwd bunfig.toml or .env

A `bunfig.toml` `preload` in a workspace would run code before the snapshot, and a `.env` file there would set keys. Every Bun process 8gent starts is protected in one of these ways:

- **Spawned children:** `--no-env-file --config=<empty>` via `safeBunFlags()` in `packages/core/bun-flags.ts`.
- **npm and shell launchers:** the same two flags with the shipped empty `bin/bunfig.empty.toml`.
- **Directly executed entry points:** the shebang `#!/usr/bin/env -S bun --no-env-file --config=/dev/null`.
- **Compiled binaries:** built with `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`.

`tests/security/launcher-cwd-config.test.ts` fails if any spawn of `bun` or `process.execPath` in the repo is missing the flags.

**`env -S` needs GNU coreutils 8.30 or newer, or BSD/macOS `env`.** BusyBox `env` has no `-S`. On BusyBox an entry point run directly through its shebang therefore fails to start with an `env` usage error. It never runs without the flags, so it fails closed. Start 8gent through `8gent` (bin/8gent-run.js) or `bin/8gent-cli.sh` there; both pass the flags explicitly.
