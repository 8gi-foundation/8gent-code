# 8gent Computer (v0)

The on-device Mac agent. Lives in the menubar, wraps `cua-driver` (the
locally-installed MIT-licensed CUA computer-use binary) via the
[`@8gent/hands`](../../packages/hands/) Bun wrapper.

This is the **8gent Computer** surface from
`memory/project_eight_vs_lil_eight.md`. It is NOT Lil Eight. Lil Eight is the
per-session pet in `apps/lil-eight/`. Both share `packages/*` and live in the
same monorepo, but they are different products.

## What v0 does

- Adds an "8" item to your menubar.
- Clicking it opens a small floating window with a prompt + Run button.
- Submitting a prompt shells out to `bun run packages/hands/run.ts "<prompt>"`,
  which plans the request via a local LLM (Ollama by default) and falls back
  to a regex stub when the model is unreachable.
- Renders the plan, the per-step result, and (for screenshot prompts) a
  preview image inline.

## What v0 does NOT do (be honest about this)

- No consent UI. Every step runs the moment the planner returns it.
- No policy / NemoClaw gating yet (#1748).
- No voice. No streaming. No memory viewer.
- No deep-link to Lil Eight.
- Not notarised. macOS will warn on first run because the app is unsigned.
- LLM planner picks wrong tools on ambiguous prompts. The stub vocabulary is
  intentionally tiny.
- SwiftUI default theme; no light/dark toggle in v0 (out of scope).

## Build

Requires:

- macOS 13+
- Swift toolchain (Command Line Tools or full Xcode).
- Bun on `~/.bun/bin/bun` or `/opt/homebrew/bin/bun`.
- `cua-driver` at `/usr/local/bin/cua-driver` (CuaDriver.app from trycua).

```bash
bash apps/8gent-computer/build.sh
open apps/8gent-computer/build/8gentComputer.app
```

## Run from source (no .app bundle)

```bash
EIGHT_REPO_ROOT="$(pwd)" \
  swift run-script apps/8gent-computer/8gentComputer/8gentComputerApp.swift
```

(Compiling all four Swift files is what `build.sh` actually does - `swift run`
without the bundle is awkward for a SwiftUI menubar app, so prefer `build.sh`.)

## Env

| Var               | Default                       | Purpose |
|-------------------|-------------------------------|---------|
| `EIGHT_REPO_ROOT` | `~/8gent-code`, then CWD      | Where `packages/hands/` lives. |
| `EIGHT_BUN`       | `~/.bun/bin/bun` etc.         | Path to the Bun executable. |
| `HANDS_PLANNER`   | unset (= LLM + stub fallback) | `stub` to force offline planning. |

The bridge propagates these to the wrapper, so any `HANDS_*` knob from
`packages/hands/README.md` works here too.

## Files

```
apps/8gent-computer/
  8gentComputer/
    8gentComputerApp.swift   # App entry, NSStatusBar menubar item
    MainWindow.swift          # Floating SwiftUI window (input + Run + output)
    HandsBridge.swift         # Subprocess shell-out to packages/hands/run.ts
    Plan.swift                # Codable mirror of packages/hands/types.ts
  Info.plist
  build.sh
  README.md (this file)
```

## Accessibility

Every interactive control has a VoiceOver label and (where useful) a hint.
This is mandatory under the 8GI accessibility primitives rule. Light/dark
toggle is deliberately out of v0 scope but should land before any external
release.

## Provenance

This wraps the CuaDriver / `cua-driver` binary (MIT, trycua/cua). When the
embedded `8gent-hands` fork lands in `packages/hands/`, the upstream MIT
licence will be preserved per the attribution plan in
`packages/hands/README.md`.
