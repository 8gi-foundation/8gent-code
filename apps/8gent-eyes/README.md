# 8gent-eyes

Headless CLI for the eyes (perception) capability. Spec §6 parity.

## Status

Ships with the eyes backend (#2503). v0 supports macOS via the bundled native AX bridge; cross-platform backends queued.

## Install

From the monorepo:

```bash
bun install
ln -sf "$(pwd)/apps/8gent-eyes/src/index.ts" /usr/local/bin/8gent-eyes
chmod +x /usr/local/bin/8gent-eyes
```

Or run directly:

```bash
bun run apps/8gent-eyes/src/index.ts <subcommand> [flags]
```

Prerequisites on macOS:

```bash
# Build the bundled Swift bridge once (installs to ~/.8gent/bin/8gent-ax-bridge).
bash packages/eyes/native/build.sh
# Grant Screen Recording + Accessibility in System Settings -> Privacy & Security.
```

## Conventions (per AgentCLIDesign)

- `--json` by default (always parseable, never narrative)
- Deterministic exit codes:
  - `0` ok
  - `1` backend error
  - `2` perception:remote tier denied
  - `3` AX bridge missing / backend unavailable
  - `64` usage error
- No telemetry beyond the audit trace store
- Headless parity: every Eyes method has a CLI form

## Subcommands

```bash
8gent-eyes capture [--display N|all|primary] [--region x,y,w,h] [--cursor] [--format png|jpeg]
8gent-eyes annotate [--display N|all|primary]
8gent-eyes locate --kind label --text "Sign in" [--role button]
8gent-eyes locate --kind role --role button [--index 0]
8gent-eyes locate --kind id --text elem_42
8gent-eyes locate --kind describe --text "the save button in the toolbar"
8gent-eyes locate --kind coords --x 400 --y 300
8gent-eyes describe [--prompt "What is on screen?"]
8gent-eyes wait-for --predicate element_visible --query-kind label --query-text "Save" [--timeout-ms 30000]
8gent-eyes wait-for --predicate text_present --text "Loading complete" [--case-sensitive]
8gent-eyes diff <a.png> <b.png>
8gent-eyes observe [--interval-ms 1000] [--threshold 0.98]   # streams JSONL
```

## --intent shorthand

Natural-language phrase routed to a subcommand:

```bash
8gent-eyes --intent "describe the screen"
8gent-eyes --intent "find the Sign in button"
8gent-eyes --intent "wait until a Save dialog appears"
```

## Output

Every successful invocation prints exactly one JSON line:

```json
{"ok": true, "frame": { "id": "frm_abc...", "path": "/tmp/8gent-eyes/...", "width": 1440, ... }}
```

`observe` streams one JSON line per emitted event (JSONL).

Errors print one JSON line then exit non-zero:

```json
{"ok": false, "exit": 3, "reason": "no perception backend available. On macOS build the bundled bridge: bash packages/eyes/native/build.sh"}
```

## Issues

- Spec: #2496, #2497, #2500
- Backend: #2502
- Tools: #2511
- This CLI: #2503
- Vision-router + remote tier fix: #2512
- Pre-existing main lint debt (cleared): #2509
