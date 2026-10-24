# run_command OS sandbox and Bun launch hygiene (#4009, #4013)

## The boundary

`packages/permissions/run-command-sandbox.ts` wraps every `run_command` and `background_start` child in an allow-default macOS Seatbelt profile. The profile denies writes, links, renames and metadata changes to 8gent's startup code, secrets and records under `~/.8gent`, under `EIGHT_HOME/.8gent` and under `EIGHT_DATA_DIR`. Reads are still allowed.

| Platform | Mechanism | When it is off |
|----------|-----------|----------------|
| macOS | Seatbelt (`sandbox-exec`), on by default | `EIGHT_SEATBELT=0`, or the host already sandboxes the process |
| Linux | bubblewrap read-only binds of the protected paths that exist (writes); Landlock for the read boundary when `EIGHT_OS_READ_BOUNDARY=1` | `bwrap` missing or unable to create a namespace; Landlock missing from the kernel or no python3 |
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

Not covered yet: the argv runner (`wrapRunCommandArgv`, the built-in git and gh tools). The live proof runs in `.github/workflows/macos-read-boundary.yml`, because `sandbox-exec` cannot nest inside a sandboxed session. That workflow also pins the macOS profile byte for byte, so the Linux slice cannot change it.

## The read boundary on Linux and Termux (#4890 slice 2, Landlock)

The same flag, `EIGHT_OS_READ_BOUNDARY=1`, uses Landlock on Linux (ABI v1 or later) and on Termux. `packages/permissions/landlock.ts` holds the rule; `linuxReadPlan()` in `run-command-sandbox.ts` builds it from the same `osReadSpec()` scope as on macOS.

How it runs: a Landlock rule restricts the process that adds it and everything that process starts, so it has to be added in the child, before the shell starts. Bun and Node have no hook there, and Termux runs the Node build. Each command is started as `python3 -I -S -c <helper> R <read grants> W <remove grants> -- /bin/sh -c <command>`. The helper calls the Landlock syscalls through ctypes, then `execv`s the shell. python3 is taken from a fixed place (`/usr/bin`, `/usr/local/bin`, `/bin`, Termux's prefix), never from `PATH`. If the helper fails after it starts, it exits 126 with a message and the command does not run. Under bwrap (the write boundary), the helper runs inside bwrap.

What it grants:

1. Read: the workspace root, the read allowances, `/allow-read` folders, the data roots, the temp folder, the `PATH` tool folders, `~/.gitconfig`, `~/.config/git`, and the system folders (`/usr`, `/bin`, `/lib*`, `/etc`, `/opt`, `/proc`, `/sys`, `/dev`, `/snap`, `/nix/store`, the resolver folders under `/run`, and on Android `/system`, `/apex`, `/vendor` and Termux's prefix). All of `/run` is not granted, because it can hold container secrets.
2. Remove and rename: everywhere except the folders that hold a never-read path.
3. From ABI v2, moves across folders (`REFER`) only between granted folders. Landlock refuses any move that would give a file read access it did not have.

The never-read set is the macOS one: `sensitiveCredentialPaths()`, `HOME_NEVER_READ`, the Linux browser and mail stores (`~/.mozilla`, `~/.config/google-chrome`, ...), the protected data roots' `keys/` and `secrets/`, and under the data roots the memory, browser, client, audit, backup, cron, key, secret, session, token and env names plus any `.db`, `.sqlite`, `.pem`, `.key` or `.p12` file.

Landlock only allows. It has no deny that beats an allow, so no folder that holds a never-read path is ever granted whole. Such a folder is granted entry by entry instead, without the never-read entries, and the same goes for any folder below it that holds one. A symlink in such a folder is never granted, because Landlock would grant its target. Inside a data root, a folder is granted whole only after a walk finds nothing private in it. The walk stops at 2000 entries per command, and any folder it cannot finish stays shut. A real `~/.8gent` can hold over a million entries, so under this rule its large folders cannot be read by commands, while its small ones (config, skills, bin) can.

What this means for a session rooted at the home folder:

- Every file and folder in the home can be read except the never-read set, the same as on macOS.
- The home folder itself, and `~/.config`, `~/.local/share` and `~/.8gent`, cannot be listed: `ls ~` fails and `ls ~/project` works. A listing grant on the home would also reach the names inside `~/.ssh`.
- A file a command creates at the top of the home cannot be read back by that same command. The next command can read it, because the lists are rebuilt for every command.
- Files at the top of the home cannot be removed or renamed. `git config --global` rewrites `~/.gitconfig` by a rename, so it fails. A rename grant on the home would also let `.ssh` be renamed to a readable name.

What it refuses that the macOS rule does not: moving any unreadable outside file into the root (#4894 item 3). `os.rename` fails with EXDEV, and `mv` falls back to a copy, which cannot read the file. Hard links are refused the same way.

Not covered: `stat`. Landlock has no metadata right, so the size and dates of a never-read file stay visible. Nothing on Linux can be built from that alone: a hard link needs `REFER`, and reflink and `copy_file_range` need a file opened for reading.

When the rule cannot be applied, the command runs as it did before, and one line per process says so: `[8gent] The OS read rule (EIGHT_OS_READ_BOUNDARY=1) is not active here: <reason>. Reads outside the workspace are stopped by text checks only.` The reasons are a kernel without Landlock, python3 not found, a probe killed by the kernel (older Android seccomp filters do this), or a platform with no Landlock at all. The probe runs once per process, in its own child, so a crash there never touches the TUI.

Termux: whether Landlock works depends on the device kernel and Android's seccomp filter. It is detected at runtime and never assumed. No Termux device has been proven in CI. The live proof for Linux is `.github/workflows/linux-read-boundary.yml` on ubuntu-latest, run once with Landlock alone and once under bwrap.

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
