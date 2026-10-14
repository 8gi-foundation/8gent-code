# The body: eyes, hands, handeyes, computer, browser

Read this before you reach for any screen, GUI or browser tooling. 8gent
already has its own stack for all of it. Do not install or call an external
CLI (browser-use, Playwright, Peekaboo, cliclick scripts of your own) until
you have checked the map below.

Everything here is checked against `origin/main` at commit `7287c387`
(6 Oct 2026). Items marked PLAN are not shipped.

## The five names, and the three things called "computer"

| Name | Where | What it is |
|------|-------|------------|
| eyes | `packages/eyes` | Perception: capture the screen, walk the macOS Accessibility (AX) tree, locate, describe, wait, diff, observe. |
| hands | `packages/hands` | Motor driver: screenshot, click, type, press, scroll, drag, hover, clipboard, window list. |
| handeyes | `packages/handeyes` | Coordination of the two when the cheap path fails (struggle mode). |
| computer | `packages/computer` | The policy and validation bridge in front of hands. Source of the `desktop_*` tools. |
| 8gent Browser | separate repo `8gi-foundation/8gent-browser` | Our own Chromium browser with a local control API. See "Browser" below. |

Three different things are named "computer". Do not mix them up:

1. `packages/computer` (this repo): the `desktop_*` bridge over `packages/hands`.
2. `apps/8gent-computer` (this repo): a small Swift menu-bar shell (voice in,
   speech out) that talks to the daemon `/computer` WebSocket route. It also
   hosts the Swift source of `accessibility-tree-cli`
   (`apps/8gent-computer/Sources/AccessibilityTreeCLI/main.swift`). It is NOT
   the computer-use loop.
3. `8gi-foundation/8gent-computer` (separate repo, cloned at `~/8gent-computer`):
   the Electron desktop app. It contains the most complete computer-use stack
   (CUA) we have: its own eyes, hands, loop, verified acting, dry run, replay,
   task runner. See "The other CUA" below.

## What each package does

### eyes (`packages/eyes`)

- Entry: `packages/eyes/index.ts`. Pick a backend with
  `selectEyesBackend([...DEFAULT_FAILOVER])`, then `backend.create({ visionProvider, sessionId })`.
- Contract: `capture`, `captureAll`, `annotate`, `locate`, `describe`,
  `wait_for`, `diff`, `observe`. Spec: `docs/specs/EYES-SPEC.md`.
- Active backend: `ax-native` (`packages/eyes/backends/ax-native.ts`), a
  bundled Swift bridge installed to `~/.8gent/bin/8gent-ax-bridge` by
  `bash packages/eyes/native/build.sh`. macOS only. Needs Screen Recording and
  Accessibility permission.
- Remote vision is gated: `describe` and `locate({kind:"describe"})` need the
  `perception:remote` tier only when the resolved provider is not local
  (`packages/eyes/perception-tier.ts`).
- `packages/eyes/marlin` is a separate video-understanding sidecar, not screen eyes.
- Headless CLI: `apps/8gent-eyes`.
- Model tools: `eyes_see`, `eyes_find`, `eyes_describe`, `eyes_wait_for`.
  They are defined in `packages/ai/tools.ts` (AI SDK `tool()` definitions) and
  listed in `packages/eight/tool-registry.ts` (`perception` category). The main
  executor `packages/eight/tools.ts` has no `eyes_*` case branches today.

### hands (`packages/hands`)

- Entry: `getDriver()` in `packages/hands/index.ts`. Uses `screencapture`,
  `cliclick` (click, type, drag, hover) and `osascript` fallbacks. Without
  `cliclick`, drag and hover return an error string; the rest still works.
- Consumers never call it directly. Everything goes through
  `packages/computer/bridge.ts`, which validates input and applies policy.

### computer (`packages/computer`)

- `packages/computer/index.ts` exports `screenshot`, `click`, `typeText`,
  `press`, `scroll`, `drag`, `hover`, `windowList`, `clipboardGet/Set`, the
  process manager (`listProcesses`, `quitByName`, ...) and `getToolDefinitions()`.
  (The header comment in `index.ts` still says usecomputer; the code path is
  `bridge.ts` -> `packages/hands`.)
- Model tools: `desktop_screenshot`, `desktop_click`, `desktop_type`,
  `desktop_press`, `desktop_scroll`, `desktop_drag`, `desktop_hover`,
  `desktop_windows`, `desktop_clipboard`, `desktop_processes`,
  `desktop_quit_app`, `desktop_suggest_quit`, `desktop_safe_list`. Executed in
  `packages/eight/tools.ts`.
- Policy: every `desktop_*` call is gated as the `desktop_use` action class
  through NemoClaw (`packages/computer/desktop-policy.ts`, rules in
  `packages/permissions/default-policies.yaml`). Dangerous key combos are
  blocked in the bridge.
- Coordinates: screenshots are downscaled; `coord-map.ts` maps image
  coordinates back to desktop coordinates.

### handeyes (`packages/handeyes`)

- Contract in `index.ts`; implementation in `handeyes-impl.ts` (orchestrator
  adapter), `engagement-loop.ts` (trigger detectors and struggle-mode
  lifecycle), `eyes-worker.ts`, `hands-queue.ts`. Spec: `docs/specs/HANDEYES-SPEC.md`.
- The default path is eyes then hands, two plain calls. Handeyes engages only
  when stuck: `find` returns zero hits twice, `wait_for` times out, a click
  produces no screen change, or the DoomLoopDetector fires.
- Model tools: `handeyes_locate_and_click`, `handeyes_click_and_verify`,
  `handeyes_type_and_confirm`, `handeyes_engage_struggle_mode`,
  `handeyes_exit_struggle_mode` (same registration as `eyes_*`: `packages/ai/tools.ts`
  plus `packages/eight/tool-registry.ts`).
- `packages/handeyes/README.md` still says "contract-only"; the implementation
  files above have since landed.

### The CUA loop (`packages/eight/loops/computer-use.ts`)

- `runComputerUseLoop(config)`: perceive, recall, decide, act, repeat. Default
  25 steps. Perception is the AX tree first (`packages/eight/perception/tree.ts`,
  backed by `packages/daemon/tools/accessibility-tree.ts` which shells out to
  the Swift `accessibility-tree-cli`), screenshot as fallback
  (`perception/screenshot.ts`). Acts only through `executeHandsTool`
  (`packages/daemon/tools/hands.ts`) so the NemoClaw gate is never bypassed.
- Terminates on `goal_complete`, `goal_failed`, `max_steps`, `internal_error`
  or `doom_loop`. Model: `vision.computerUseModel` in `~/.8gent/config.json`
  (default `qwen3.6:27b`, resolved by `packages/eight/vision-router.ts`).
- Reached by the model as the `run_computer_task` tool
  (`handleRunComputerTask` in `packages/eight/tools.ts`) and from
  `packages/eight/scripts/cua-run.ts`.
- Note: this loop has no verification step after an action and no dry run. The
  other CUA does (below).

## How the TUI BODY panel reflects this

- `apps/tui/src/hooks/useBodyParts.ts` holds in-memory state for `hands`,
  `eyes`, `handeyes`: `disabled`, `idle`, `inFlight`.
- Defaults at launch: hands on if `cliclick` is on PATH; eyes on if
  `~/.8gent/bin/8gent-ax-bridge` exists; handeyes on if both.
- A running tool lights its part by name prefix (`bodyPartForToolName`):
  `desktop_*` is hands, `eyes_*` is eyes, `handeyes_*` is handeyes.
  `run_computer_task`, `browser_*` and `computer`-route traffic light nothing.
- The `BODY` section is rendered in `apps/tui/src/components/ActivityRail.tsx`.
  `/hands`, `/eyes`, `/handeyes` toggle a part (`apps/tui/src/app.tsx`).
- It is a visual indicator only. Toggling off does not stop the tools.

## The other CUA: `8gi-foundation/8gent-computer`

The Electron repo (`~/8gent-computer`, `src/main/cu/`) has the most mature
computer-use stack in the org. It is TypeScript and shares no code with
this repo today. Its public contract, in short (full detail in that repo's
`docs/ARCHITECTURE-COMPUTER-USE.md`):

- `actionSpec.ts`: the canonical 16-kind action vocabulary (Anthropic
  computer-use shape), validation and parsing of model output.
- `loop.ts`: `runCUSession`, screenshot, decide, act, hard turn ceiling.
- `verify.ts`: `verifiedAct`, act then re-check a scene expectation with retry
  and re-resolve.
- `dryRun.ts` and `liveRun.ts`: simulate a plan against a frozen AX snapshot,
  classify risk, pause a live run on divergence.
- `actionLog.ts` and `replay.ts`: per-session JSONL action log and a step
  debugger over it.
- `targets.ts`: per-session allowlist plus frontmost-app gate for driving other apps.
- Remote control: its remote-control API on `ws://127.0.0.1:7979` accepts
  `{type:"cu:start", sessionId, goal, modelId}` and streams progress. It must
  be running (started from that repo, or the app).

Where 8gent-code could reuse it (PLAN, nothing wired): `verifiedAct` and the
dry-run/risk classifier are the two pieces our `runComputerUseLoop` lacks.
Drive it over the 7979 `cu:*` messages, or port the concepts, per the "import
concepts, not code" rule in the top-level instructions file.

## Browser

There are two unrelated browser surfaces. Know which one you are calling.

1. `packages/tools/browser/` is fetch plus a DuckDuckGo HTML scraper with a
   disk cache. No JavaScript, no login, no clicking. Good for reading static pages.
2. The `browser_open`, `browser_state`, `browser_task`, `browser_screenshot`
   tools (`packages/eight/tools.ts`, cases near `browser_open`) drive 8gent Browser
   through `packages/tools/eight-browser.ts` (issue #3589, landed). The old
   `browser-use` CLI (`packages/tools/browser-use.ts`) is opt-in only: set
   `EIGHT_BROWSER_BACKEND=browser-use`. Only that fallback takes a natural-language
   `task`; on 8gent Browser, `browser_task` takes an `actions` list.

**8gent Browser** (`8gi-foundation/8gent-browser`, an Electron app, local
checkout `~/8gent-browser`) exposes a token-gated loopback WebSocket control
API on `ws://127.0.0.1:7980` (`src/main/control-server.ts` in that repo). The
token is at `~/.8gent/browser-control.token`. `eight-browser.ts` is the client
the tools use. The read-only client `~/.8gent/bin/8b-web` (`tabs`, `open`,
`text`, `scroll`, `shot`, `close`, `close-mine`) talks to the same channel and
is what the X scout uses.

How the tools behave on main:

- `browser_open` opens the URL in a new tab and returns the tab id, title,
  numbered elements and page text. `browser_state` re-reads the tab.
- `browser_task` runs verified steps: `open`, `left_click`, `type`, `wait_for`,
  `scroll` (at most 25 steps). The whole plan is checked against the current page
  before the first step. A `type` that did not land is retried once, then the plan
  stops. Clicks are never retried. Typed text is logged as length only.
- `browser_screenshot` saves a `.png` of the tab.
- Only tabs this process opened are driven, never the person's own tabs.
- `browser_task` and `browser_screenshot` ask first, like `desktop_*`, because the
  default tabs share the person's logged-in session. A sensitive click (sign in,
  purchase, delete, send) gets its own approval card even inside an approved task.
- `EIGHT_BROWSER_PROFILE=<name>` points every call at that profile's own
  login-free 8gent Browser instance (no fallback to the default token or port).
  A local-model session uses the isolated profile `eight-local` when none is set;
  `EIGHT_BROWSER_LOCAL=0` opts out.
- Loopback URLs are reachable inside an isolated profile only on the ports listed
  in `EIGHT_BROWSER_ALLOW_LOOPBACK` (comma separated, for example `127.0.0.1:5173`).

For anything the tools do not cover (`page.query`, `nav.go` and the rest of the
control API), use the WebSocket protocol directly. See that repo's README,
"Driving it from an 8gent".

## Decision table

| I need to... | Use |
|--------------|-----|
| See what is on the Mac screen | `eyes_see`, or `desktop_screenshot` for pixels only |
| Click or type on the Mac desktop | `eyes_find` then `desktop_click` / `desktop_type`; `handeyes_*` when it keeps missing |
| Finish a multi-step desktop goal | `run_computer_task` (this repo), or `cu:start` on the Electron app's 7979 API for verified acting |
| Read a static web page | `packages/tools/browser/` fetch, or `8b-web open` then `8b-web text` |
| Read a JS-rendered or logged-in page | `browser_open` / `browser_state`, or `8b-web` (read-only) |
| Click or type in a web page | `browser_open` then `browser_task` (8gent Browser). Not browser-use. |
