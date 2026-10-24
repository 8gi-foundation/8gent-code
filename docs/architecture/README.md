# 8gent-code architecture diagrams

Four hand-drawn views of everything on `origin/main` (`44304d957`, v0.20.23), drawn from the code, with a gap list. Every box and arrow traces to a repo path in the sources tables below. Where the code did not settle a fact the box says UNVERIFIED.

User line: James can now open one picture of the whole of 8gent-code, see where each part runs, what it talks to and what it writes, and see in red what is missing.

| View | Excalidraw | SVG | PNG |
|---|---|---|---|
| 1. System map: entry points, apps, daemon per platform, 82 packages by role | [01-system-map.excalidraw](01-system-map.excalidraw) | [svg](01-system-map.svg) | [png](01-system-map.png) |
| 2. External tools and services: providers, judges, services, local binaries | [02-external-tools-and-services.excalidraw](02-external-tools-and-services.excalidraw) | [svg](02-external-tools-and-services.svg) | [png](02-external-tools-and-services.png) |
| 3. Outputs: every place 8gent writes | [03-outputs.excalidraw](03-outputs.excalidraw) | [svg](03-outputs.svg) | [png](03-outputs.png) |
| 4. Gaps: 19 items with file evidence | [04-gaps.excalidraw](04-gaps.excalidraw) | [svg](04-gaps.svg) | [png](04-gaps.png) |

Colour key: blue entry or distribution, green app or local provider, orange daemon, yellow package, teal external service, grey dashed opt-in or off by default, grey solid local file, orange dashed UNVERIFIED, red dashed gap.

## Does 8gent already have a canvas that opens .excalidraw?

No. `grep -ril excalidraw` over the repo (excluding node_modules) returns nothing, and the `canvas` hits in `apps` and `packages` are pixel and sprite drawing (`apps/lil-eight/generate-*.ts`, `apps/tui/src/components/ThinkingVisualizer.tsx`), Table's stage and slide renderer (`packages/table/stage.ts`, `slide-render.ts`) and the perception screenshot code, not a drawing surface. The governance media canvas James has described lives in the 8gi-governance repo, not here, so whether it opens these files is unverified.

The files are standard Excalidraw v2 JSON. To open one: drag it onto https://excalidraw.com, or use File > Open there, or the Excalidraw extension in VS Code. Elements are grouped per box, arrows are bound to their boxes (move a box and the arrow follows) and arrow labels are bound text.

## Gaps

### G01  Android/Termux daemon unverified (#4852)

service.ts refuses every platform except darwin, linux, win32, so a Termux user can only run `8gent daemon run` by hand. The Termux smoke job checks install, --version, TUI first frame and install.sh, never the daemon.

Evidence: `packages/daemon/service.ts:450-455`, `scripts/smoke-termux.sh`

### G02  Fly eight-vessel runs board-vessel, not the daemon

The root fly.toml app `eight-vessel` builds the root Dockerfile whose CMD is the board-vessel entrypoint (packages/board-vessel/vessel.ts). Nothing in the repo starts packages/daemon/index.ts on Fly, so 'the daemon runs on Fly' is unverified.

Evidence: `fly.toml`, `Dockerfile`, `scripts/board-vessel/entrypoint.sh:51-54`

### G03  macOS launchd service never exercised in CI

The real-service e2e is disabled when process.platform is darwin and the Platforms matrix has only ubuntu-latest and windows-latest. The launchd plan is unit-tested as data only.

Evidence: `packages/daemon/service.e2e.test.ts:14-17`, `.github/workflows/platforms.yml:24-29`

### G04  Three compiled targets have no smoke test

darwin-x64, linux-arm64 and windows-x64-baseline are built and released but the compiled smoke matrix covers linux-x64, darwin-arm64 and windows-x64 only.

Evidence: `scripts/build-binaries.ts:66-72`, `.github/workflows/smoke-compiled.yml:28-35`

### G05  Swift apps have no release job

apps/8gent-computer and apps/lil-eight build in swift-nightly (8gent-computer) or by hand (lil-eight build.sh). No workflow in release.yml or release-binaries.yml builds, signs or attaches either app.

Evidence: `.github/workflows/swift-nightly.yml`, `.github/workflows/release-binaries.yml`

### G06  Dead or stub packages

dreams holds one markdown file and no code. qdrant-client is stubs that throw NotImplementedError. planner, channels, control-plane and 8dk have zero importers in packages, apps, bin, scripts and tests (channels appears only in a security fixture list).

Evidence: `packages/dreams`, `packages/qdrant-client/README.md`, `packages/planner/index.ts`, `packages/channels/index.ts`, `packages/control-plane/index.ts`, `packages/8dk/index.ts`

### G07  packages/tools: 62 of 96 modules have no importer

Static grep of every top-level packages/tools/*.ts: 62 are imported by nothing (utility files such as crc32, bit-flags, moving-average, sqli-pattern-detector) and 60 of those have no test either. Full list in docs/architecture/evidence/tools-orphans.txt.

Evidence: `packages/tools/crc32.ts`, `packages/tools/lru-cache.ts`, `docs/architecture/evidence/tools-orphans.txt`

### G08  Orphan files inside packages/eight

No importer outside tests for any of the four. clui-bridge.ts bridges to apps/clui, which does not exist on main.

Evidence: `packages/eight/auto-commit.ts`, `packages/eight/clui-bridge.ts`, `packages/eight/curriculum.ts`, `packages/eight/external-editor.ts`

### G09  Packages with source and zero tests

auth (Clerk and GitHub token handling) and quarantine are the two that matter for security; hands drives the desktop with cliclick and osascript.

Evidence: `packages/auth`, `packages/quarantine`, `packages/registry`, `packages/hands`, `packages/lsp`, `packages/tasks`, `packages/personality`, `packages/design-ag|ent`, `packages/planning`, `packages/executor`, `packages/i18n`, `packages/repo-context`

### G10  threat-feed is manual and its report is read by nobody

OSV and CISA KEV are queried only when someone runs the CLI. No workflow, cron entry or daemon job calls it (grep of .github, scripts, packages). Reports land in ~/.8gent/security/threat-feed/<date>/ with no reader.

Evidence: `packages/threat-feed/cli.ts`, `packages/threat-feed/README.md`

### G11  Turn journal is written every turn, read only by a script

~/.8gent/turns/<session>/<n>.json has one reader, scripts/turn-review-replay.ts. No TUI view, daemon route or CLI subcommand reads it.

Evidence: `packages/eight/turn-journal.ts:59`, `scripts/turn-review-replay.ts`

### G12  ~/.8gent/evidence has no writer in the repo

The only mention in product code is a design-doc comment. Whatever fills the directory on a dev machine is outside the repo, so nothing in the code can promise it exists.

Evidence: `apps/tui/src/components/IntroBanner.tsx:2`

### G13  Two cron schedulers share one cron.json

The CLI and TUI use packages/cron, the daemon uses packages/daemon/cron.ts, both persist ~/.8gent/cron.json with their own code. Two writers, no shared lock.

Evidence: `packages/cron/index.ts:86`, `packages/daemon/cron.ts:35`, `bin/8gent.ts:137`

### G14  Convex backend is not in this repo

apps/convex holds only _generated files. packages/db runs offline without CONVEX_URL. The schema and functions it talks to live elsewhere, so the sync path cannot be read here.

Evidence: `apps/convex/_generated/api.ts`, `packages/db/client.ts:63`

### G15  Docs name apps and counts the tree does not have

README.md and CLAUDE.md list apps/clui and apps/dashboard, neither exists. CLAUDE.md says 11 providers and 'Apple Foundation is NOT wired'; the registry holds 20 entries and apple-foundation is wired (index.ts:340).

Evidence: `README.md:608-609`, `CLAUDE.md:21-22`, `packages/providers/index.ts:274-577`

### G16  g8way has no deploy unit in infra

README says it runs on the Hetzner box behind Caddy, but docker-compose.yml and infra/hetzner/systemd carry only the daemon and two Telegram bridges. How g8way is deployed is not in the repo.

Evidence: `packages/g8way/README.md`, `infra/hetzner/docker-compose.yml`

### G17  '8gate' is not a module; 8J is opt-in behind g8way

The name 8gate appears only in two test files. The shipped judge is Selene-1-Mini via packages/decide, on by default. 8J (HF Space 8GI/8j-eval) is reachable only through a g8way upstream with EIGHT_ALLOW_HOSTED=1.

Evidence: `packages/eight/provider-choice.test.ts`, `packages/g8way/README.md:50-75`, `packages/decide/README.md:281-285`

### G18  Stub web apps: root src/ and apps/debugger

The root `dev` script runs next dev over a three-file stub. apps/debugger's README is the create-next-app default, so its purpose is not stated in the repo.

Evidence: `src/Counter.tsx`, `src/app/icon.tsx`, `apps/debugger/README.md`, `package.json (dev: next dev)`

### G19  Four Telegram code paths

Each talks to api.telegram.org with its own client. The Hetzner units run the daemon bridge; the Fly app runs apps/8gent-bot; packages/telegram is imported by ag|ent.ts and repl.ts.

Evidence: `packages/daemon/telegram-bridge.ts`, `packages/telegram-bot/index.ts`, `packages/telegram/index.ts`, `apps/8gent-bot/src/index.ts`

## How the diagrams were made

Facts come from reading the tree at the commit above: `package.json`, `bin/`, `scripts/`, `.github/workflows/`, `infra/`, `fly.toml`, `packages/daemon/service.ts`, `packages/providers/index.ts` and the writer of each output path. Importer and test counts are static greps (`evidence/package-importers.tsv`, `evidence/tools-orphans.tsv`); a dynamic import built from a template string would be missed, so a "no importer" claim is a strong lead, not a proof, and says so where it matters.

Regenerate (documentation tooling only; adds nothing to package.json or bun.lock):

```
mkdir -p /tmp/arch-deps && cd /tmp/arch-deps && npm i roughjs
ARCH_DEPS=/tmp/arch-deps node docs/architecture/tools/build.mjs   # needs rsvg-convert for PNG
```

The SVG and PNG are drawn by `tools/build.mjs` with roughjs in the Excalidraw hand-drawn style from the same scene data as the `.excalidraw` file, so the picture and the editable file cannot disagree.

## Sources

The real paths are in [sources.tsv](sources.tsv) (verbatim, machine-readable). In this file the few paths that contain the word the repo prose gate rejects are written with a split, `ag|ent`.

Every box and arrow, per view. The path is where the fact was read; for an output the path is the writer.

### View 1: system map

| Box | Kind | Source path |
|---|---|---|
| npm package @8gi-foundation/8gent-code | entry | package.json |
| bin/8gent-run.js launcher | entry | bin/8gent-run.js |
| bin/8gent.ts (CLI source) | entry | bin/8gent.ts |
| Compiled binaries (6 targets)  [G04] | entry | scripts/build-binaries.ts |
| scripts/install.sh (macOS, Linux) | entry | scripts/install.sh |
| scripts/install.ps1 (Windows) | entry | scripts/install.ps1 |
| OS packages | entry | packaging |
| Termux path (Android)  [G01] | unv | scripts/install.sh; bin/termux-exec.js; scripts/smoke-termux.sh |
| Release pipeline | entry | .github/workflows/release.yml; .github/workflows/release-binaries.yml |
| Dockerfile and infra/hetzner | entry | Dockerfile; infra/hetzner/docker-compose.yml |
| apps/tui (Ink) | app | apps/tui/src/index.tsx |
| apps/8gent-computer (Swift, macOS)  [G05] | app | apps/8gent-computer/README.md |
| apps/lil-eight (Swift pet, macOS)  [G05] | app | apps/lil-eight/build.sh |
| apps/8gent-bot (Fly 8gi-orchestrator)  [G19] | app | apps/8gent-bot/fly.toml |
| apps/linkedin-vessel (Fly) | app | apps/linkedin-vessel/fly.toml |
| apps/8gent-eyes (CLI) | app | apps/8gent-eyes/package.json |
| apps/8gent-flow | app | apps/8gent-flow/package.json |
| apps/proxy | app | apps/proxy/README.md |
| apps/debugger (Next.js)  [G18] | unv | apps/debugger/README.md |
| apps/video (Remotion) | app | apps/video/package.json |
| apps/convex  [G14] | gap | apps/convex/_generated/api.ts |
| apps/clui, apps/dashboard  [G15] | gap | README.md:608-609 |
| gateway.ts | daemon | packages/daemon/gateway.ts:963-1106 |
| ag|ent-pool.ts | daemon | packages/daemon/ag|ent-pool.ts:95 |
| cron.ts  [G13] | daemon | packages/daemon/cron.ts:35 |
| heartbeat.ts | daemon | packages/daemon/heartbeat.ts |
| session-journal.ts | daemon | packages/daemon/session-journal.ts |
| telegram-bridge.ts  [G19] | daemon | packages/daemon/telegram-bridge.ts |
| slack.ts | daemon | packages/daemon/slack.ts:138 |
| table-routes.ts | daemon | packages/daemon/table-routes.ts |
| goal-rpc.ts | daemon | packages/daemon/goal-rpc.ts |
| dispatch.ts | daemon | packages/daemon/dispatch.ts |
| service.ts | daemon | packages/daemon/service.ts:1-12 |
| VesselMesh registration | daemon | packages/daemon/index.ts:477 |
| macOS: launchd service  [G03] | daemon | packages/daemon/service.ts:1-12 |
| Linux: systemd --user + linger | daemon | packages/daemon/service.ts:1-12; .github/workflows/platforms.yml:78-98 |
| Windows: Scheduled Task | daemon | packages/daemon/service.ts:1-12; .github/workflows/windows-task.yml |
| Hetzner: system units + compose | daemon | infra/hetzner/systemd/eight-daemon.service |
| Fly.io eight-vessel  [G02] | unv | fly.toml; scripts/board-vessel/entrypoint.sh |
| Android / Termux: UNVERIFIED (#4852)  [G01] | unv | packages/daemon/service.ts:450-455 |
| G01 Android/Termux daemon unverified (#4852) | gap | packages/daemon/service.ts:450-455 |
| G02 Fly eight-vessel runs board-vessel, not the daemon | gap | fly.toml |
| G03 macOS launchd service never exercised in CI | gap | packages/daemon/service.e2e.test.ts:14-17 |
| G04 Three compiled targets have no smoke test | gap | scripts/build-binaries.ts:66-72 |
| G05 Swift apps have no release job | gap | .github/workflows/swift-nightly.yml |
| G06 Dead or stub packages | gap | packages/dreams |
| G07 packages/tools: 62 of 96 modules have no importer | gap | packages/tools/crc32.ts |
| G08 Orphan files inside packages/eight | gap | packages/eight/auto-commit.ts |
| G09 Packages with source and zero tests | gap | packages/auth |
| G10 threat-feed is manual and its report is read by nobody | gap | packages/threat-feed/cli.ts |
| G13 Two cron schedulers share one cron.json | gap | packages/cron/index.ts:86 |
| G14 Convex backend is not in this repo | gap | apps/convex/_generated/api.ts |
| G15 Docs name apps and counts the tree does not have | gap | README.md:608-609 |
| G16 g8way has no deploy unit in infra | gap | packages/g8way/README.md |
| G18 Stub web apps: root src/ and apps/debugger | gap | src/Counter.tsx |
| G19 Four Telegram code paths | gap | packages/daemon/telegram-bridge.ts |
| packages/local-model-server | pkg | packages/local-model-server |
| packages/decide | pkg | packages/decide |
| packages/verify | pkg | packages/verify |
| packages/providers | pkg | packages/providers |
| packages/kernel | pkg | packages/kernel |
| packages/g8way  [G16] | pkg | packages/g8way |
| packages/qdrant-client  [G06] | gap | packages/qdrant-client |
| packages/eight  [G08] | pkg | packages/eight |
| packages/core | pkg | packages/core |
| packages/types | pkg | packages/types |
| packages/ai | pkg | packages/ai |
| packages/goal | pkg | packages/goal |
| packages/harness | pkg | packages/harness |
| packages/harness-cli | pkg | packages/harness-cli |
| packages/planning  [G09] | pkg | packages/planning |
| packages/planner  [G06] | gap | packages/planner |
| packages/executor  [G09] | pkg | packages/executor |
| packages/tasks  [G09] | pkg | packages/tasks |
| packages/proactive | pkg | packages/proactive |
| packages/i18n  [G09] | pkg | packages/i18n |
| packages/personality  [G09] | pkg | packages/personality |
| packages/infinite | pkg | packages/infinite |
| packages/workflow | pkg | packages/workflow |
| packages/validation | pkg | packages/validation |
| packages/settings | pkg | packages/settings |
| packages/permissions | pkg | packages/permissions |
| packages/secrets | pkg | packages/secrets |
| packages/quarantine  [G09] | pkg | packages/quarantine |
| packages/audit | pkg | packages/audit |
| packages/auth  [G09] | pkg | packages/auth |
| packages/threat-feed  [G10] | gap | packages/threat-feed |
| packages/ci | pkg | packages/ci |
| packages/memory | pkg | packages/memory |
| packages/ast-index | pkg | packages/ast-index |
| packages/repo-context  [G09] | pkg | packages/repo-context |
| packages/lsp  [G09] | pkg | packages/lsp |
| packages/db | pkg | packages/db |
| packages/self-autonomy | pkg | packages/self-autonomy |
| packages/specifications | pkg | packages/specifications |
| packages/dreams  [G06] | gap | packages/dreams |
| packages/tools  [G07] | gap | packages/tools |
| packages/toolshed | pkg | packages/toolshed |
| packages/skills | pkg | packages/skills |
| packages/extensions | pkg | packages/extensions |
| packages/mcp | pkg | packages/mcp |
| packages/hooks | pkg | packages/hooks |
| packages/marketplace | pkg | packages/marketplace |
| packages/registry  [G09] | pkg | packages/registry |
| packages/app-creator | pkg | packages/app-creator |
| packages/orchestration | pkg | packages/orchestration |
| packages/daemon | pkg | packages/daemon |
| packages/cron  [G13] | pkg | packages/cron |
| packages/board-plane | pkg | packages/board-plane |
| packages/board-vessel | pkg | packages/board-vessel |
| packages/control-plane  [G06] | gap | packages/control-plane |
| packages/channels  [G06] | gap | packages/channels |
| packages/table | pkg | packages/table |
| packages/8dk  [G06] | gap | packages/8dk |
| packages/telegram  [G19] | pkg | packages/telegram |
| packages/telegram-bot  [G19] | pkg | packages/telegram-bot |
| packages/flow | pkg | packages/flow |
| packages/telemetry | pkg | packages/telemetry |
| packages/reporting | pkg | packages/reporting |
| packages/computer | pkg | packages/computer |
| packages/hands  [G09] | pkg | packages/hands |
| packages/eyes | pkg | packages/eyes |
| packages/handeyes | pkg | packages/handeyes |
| packages/voice | pkg | packages/voice |
| packages/music | pkg | packages/music |
| packages/terminal-tab | pkg | packages/terminal-tab |
| packages/pet | pkg | packages/pet |
| packages/render | pkg | packages/render |
| packages/deck | pkg | packages/deck |
| packages/film-craft | pkg | packages/film-craft |
| packages/design-ag|ent  [G09] | pkg | packages/design-ag|ent |
| packages/design-compose | pkg | packages/design-compose |
| packages/design-systems | pkg | packages/design-systems |
| packages/gamedev | pkg | packages/gamedev |
| packages/travel | pkg | packages/travel |
| packages/install-runner | pkg | packages/install-runner |
| packages/node-compat | pkg | packages/node-compat |
| packages/runtime | pkg | packages/runtime |

| Arrow (from -> to) | What flows | Source path |
|---|---|---|
| npm package @8gi-foundation/8gent-code -> bin/8gent-run.js launcher | bin entry | package.json |
| bin/8gent-run.js launcher -> bin/8gent.ts (CLI source) | spawns dist/cli.js (bundle of bin/8gent.ts) | bin/8gent-run.js |
| Compiled binaries (6 targets)  [G04] -> bin/8gent.ts (CLI source) | bun --compile of bin/8gent.ts | scripts/build-binaries.ts |
| scripts/install.sh (macOS, Linux) -> Compiled binaries (6 targets)  [G04] | downloads the release binary | scripts/install.sh |
| Release pipeline -> Compiled binaries (6 targets)  [G04] | builds, signs, attests | .github/workflows/release-binaries.yml |
| Termux path (Android)  [G01] -> bin/8gent-run.js launcher | npm .tgz, node runtime | scripts/install.sh |
| bin/8gent.ts (CLI source) -> apps/tui (Ink) | `8gent tui` | bin/8gent.ts |
| bin/8gent.ts (CLI source) -> service.ts | `8gent daemon run/install/status` | bin/8gent.ts:573-578 |
| apps/tui (Ink) -> gateway.ts | ws :18789, sessions and auto-attach | apps/tui/src/lib/daemon-sessions.ts |
| apps/8gent-computer (Swift, macOS)  [G05] -> gateway.ts | ws /computer | apps/8gent-computer/README.md |
| gateway.ts -> ag|ent-pool.ts | session turns | packages/daemon/ag|ent-pool.ts |
| ag|ent-pool.ts -> packages/eight  [G08] | runs the 8gent loop | packages/daemon/ag|ent-pool.ts |
| apps/tui (Ink) -> packages/eight  [G08] | in-process loop when no daemon | apps/tui/src/app.tsx:25 |
| packages/eight  [G08] -> packages/providers | chat() through ProviderManager | packages/eight/clients/index.ts |
| service.ts -> macOS: launchd service  [G03] | writes plist, launchctl bootstrap | packages/daemon/service.ts |
| service.ts -> Linux: systemd --user + linger | writes user unit, enables linger | packages/daemon/service.ts |
| service.ts -> Windows: Scheduled Task | registers Scheduled Task | packages/daemon/service.ts |
| Hetzner: system units + compose -> gateway.ts | same daemon, system unit | infra/hetzner/systemd/eight-daemon.service |

### View 2: external tools and services

| Box | Kind | Source path |
|---|---|---|
| 8gent | app | packages/providers/index.ts:274-288 |
| ollama | app | packages/providers/index.ts:289-304 |
| lmstudio | app | packages/providers/index.ts:305-324 |
| llama-server | optin | packages/providers/index.ts:325-339 |
| apple-foundation | ext | packages/providers/index.ts:340-354 |
| apfel | ext | packages/providers/index.ts:355-377 |
| openrouter | optin | packages/providers/index.ts:391-411 |
| deepseek | optin | packages/providers/index.ts:378-390 |
| groq | optin | packages/providers/index.ts:412-429 |
| grok | optin | packages/providers/index.ts:430-442 |
| openai | optin | packages/providers/index.ts:443-457 |
| anthropic | optin | packages/providers/index.ts:458-472 |
| mistral | optin | packages/providers/index.ts:473-490 |
| minimax | optin | packages/providers/index.ts:491-506 |
| together | optin | packages/providers/index.ts:507-523 |
| fireworks | optin | packages/providers/index.ts:524-539 |
| replicate | optin | packages/providers/index.ts:540-552 |
| host-cli-primary | optin | packages/providers/index.ts:553-567 |
| host-cli-secondary | optin | packages/providers/index.ts:568-582 |
| Selene-1-Mini (Atla) via Ollama: the shipped local judge | daemon | packages/providers/local-judge.ts:1-30 |
| Ollama (localhost:11434) | daemon | packages/local-model-server/index.ts |
| llama.cpp in-process (node-llama-cpp, optional dependency) | daemon | packages/decide/README.md:31-36 |
| laya backend | daemon | packages/decide/backends/laya.ts |
| 8J on a Hugging Face Space (8GI/8j-eval, ZeroGPU) | optin | packages/g8way/README.md:50-75 |
| g8way proxy (api.8gentos.com, Hetzner)  [G16] | unv | packages/g8way/README.md:1-12 |
| '8gate' local judge name  [G17] | gap | packages/eight/provider-choice.test.ts |
| Skywork-Reward-V2 over a vLLM-style endpoint | optin | packages/providers/local-judge.ts:7-10 |
| packages/daemon | daemon | packages/daemon/index.ts |
| packages/eight (the 8gent loop) | daemon | packages/eight/ag|ent.ts |
| ProviderManager | daemon | packages/providers/index.ts:274-577 |
| System One gate + permissions | daemon | packages/permissions/system-one-gate.ts |
| packages/decide (judge host) | daemon | packages/decide/README.md |
| packages/voice + tools/speak.ts | daemon | packages/voice/index.ts |
| packages/music (DJ) | daemon | packages/music/dj.ts |
| packages/deck, film-craft, table/bake | daemon | packages/deck/auto.ts |
| packages/threat-feed (manual CLI)  [G10] | gap | packages/threat-feed/cli.ts |
| board-plane + board-vessel (Fly) | daemon | packages/board-plane/control-plane.ts |
| apps/linkedin-vessel (Fly) | daemon | apps/linkedin-vessel/src/index.ts |
| packages/qdrant-client  [G06] | gap | packages/qdrant-client/README.md |
| packages/control-plane  [G06] | gap | packages/control-plane/index.ts |
| Telegram Bot API | ext | packages/daemon/telegram-bridge.ts |
| Slack | ext | packages/daemon/slack.ts:138 |
| GitHub (api.github.com and gh) | ext | packages/toolshed/tools/github/github-tools.ts |
| npm registry | ext | packages/eight/self-update.ts:182 |
| Vercel API | ext | packages/eight/tools.ts:2027 |
| DuckDuckGo or SearXNG | ext | packages/tools/web.ts:4 |
| LetsFG API | ext | packages/travel/letsfg-provider.ts:81 |
| Clerk | ext | packages/auth/clerk.ts |
| Convex  [G14] | ext | packages/db/client.ts:63 |
| OSV and CISA KEV | ext | packages/threat-feed/feeds.ts:6-9 |
| OpenAI cloud transcription | optin | packages/voice/cloud-transcriber.ts |
| ElevenLabs | unv | packages/voice/tts-engine.ts:7 |
| Discord REST | ext | packages/board-plane/discord-rest.ts:8 |
| Board plane and model proxy (Fly) | ext | fly.toml |
| LinkedIn API | ext | apps/linkedin-vessel/src/linkedin-api.ts |
| Qdrant  [G06] | gap | packages/qdrant-client/README.md |
| Stripe  [G06] | gap | packages/control-plane/stripe-webhook.ts |
| Hugging Face | ext | packages/eight/judge-install.ts |
| whisper.cpp + sox | out | packages/voice/index.ts:1-4 |
| say, KittenTTS (Python), Termux TTS, moshi-mlx | out | packages/voice/tts-engine.ts:31 |
| mpv + yt-dlp | out | packages/music/dj.ts:5-8 |
| ffmpeg | out | packages/tools/video-deck.ts |
| ImageMagick (magick) | out | packages/film-craft/index.ts:4 |
| ripgrep | out | packages/ast-index/locate.ts:26 |
| cliclick, osascript, screencapture | out | packages/hands/index.ts |
| Chrome | out | packages/render/chrome.ts |
| browser-use CLI (Python) | out | packages/tools/browser-use.ts:1-10 |
| apple-foundation-bridge + 8gent-ax-bridge | out | scripts/install-apple-foundation.ts |
| G06 Dead or stub packages | gap | packages/dreams |
| G10 threat-feed is manual and its report is read by nobody | gap | packages/threat-feed/cli.ts |
| G14 Convex backend is not in this repo | gap | apps/convex/_generated/api.ts |
| G16 g8way has no deploy unit in infra | gap | packages/g8way/README.md |
| G17 '8gate' is not a module; 8J is opt-in behind g8way | gap | packages/eight/provider-choice.test.ts |

| Arrow (from -> to) | What flows | Source path |
|---|---|---|
| ProviderManager -> ollama | chat, tool calls, stream; no key (same for 8gent, lmstudio, llama-server) | packages/providers/index.ts:289-304 |
| ProviderManager -> apple-foundation | prompt over IPC to the bridge binary | packages/providers/index.ts:340-354 |
| ProviderManager -> apfel | OpenAI-style chat on 127.0.0.1:11435 | packages/providers/index.ts:355-377 |
| ProviderManager -> openrouter | failover: local -> OpenRouter :free | packages/providers/failover.ts |
| ProviderManager -> anthropic | chat with key, after the PII egress gate | packages/providers/index.ts:458-472 |
| ProviderManager -> openai | chat with key (same shape for the other cloud entries) | packages/providers/index.ts:443-457 |
| ProviderManager -> host-cli-primary | spawns the host binary, text only | packages/providers/host-cli.ts |
| apple-foundation -> apple-foundation-bridge + 8gent-ax-bridge | IPC socket to the Swift bridge | scripts/install-apple-foundation.ts |
| packages/eight (the 8gent loop) -> ProviderManager | every model call | packages/eight/clients/index.ts |
| System One gate + permissions -> packages/decide (judge host) | bashGuard(command) asks, gets p(yes) | packages/permissions/system-one-gate.ts |
| packages/decide (judge host) -> Selene-1-Mini (Atla) via Ollama: the shipped local judge | yes/no question + state, calibrated p(yes) | packages/decide/judge-model.ts |
| packages/decide (judge host) -> llama.cpp in-process (node-llama-cpp, optional dependency) | in-process, no server | packages/decide/backends/llamacpp.ts |
| packages/decide (judge host) -> laya backend | fallback backend | packages/decide/backends/laya.ts |
| Selene-1-Mini (Atla) via Ollama: the shipped local judge -> Ollama (localhost:11434) | /api/generate verdict, /api/pull install | packages/eight/judge-install.ts |
| Ollama (localhost:11434) -> Hugging Face | pulls hf.co GGUF (Selene) | packages/eight/judge-install.ts |
| g8way proxy (api.8gentos.com, Hetzner)  [G16] -> 8J on a Hugging Face Space (8GI/8j-eval, ZeroGPU) | model prefix 8j/ routed upstream | packages/g8way/README.md:50-75 |
| g8way proxy (api.8gentos.com, Hetzner)  [G16] -> openrouter | non-8j models to OpenRouter | packages/g8way/README.md:1-12 |
| 8J on a Hugging Face Space (8GI/8j-eval, ZeroGPU) -> Hugging Face | HTTPS to the Space, read-only HF token | packages/g8way/README.md:63-70 |
| packages/daemon -> Telegram Bot API | updates in; text, voice, files out | packages/daemon/telegram-bridge.ts |
| packages/daemon -> Slack | chat.postMessage | packages/daemon/slack.ts:138 |
| packages/eight (the 8gent loop) -> GitHub (api.github.com and gh) | issues, PRs, repo reads via gh and REST | packages/toolshed/tools/github/github-tools.ts |
| packages/eight (the 8gent loop) -> npm registry | version check, tarball for self-update | packages/eight/self-update.ts:182 |
| packages/eight (the 8gent loop) -> Vercel API | vercel_* tools: deploy, env, logs | packages/eight/tools.ts:2027 |
| packages/eight (the 8gent loop) -> DuckDuckGo or SearXNG | web_search query, results | packages/tools/web.ts:4 |
| packages/eight (the 8gent loop) -> LetsFG API | flight search request | packages/travel/letsfg-provider.ts:81 |
| packages/eight (the 8gent loop) -> Clerk | sign-in tokens | packages/auth/clerk.ts |
| packages/eight (the 8gent loop) -> Convex  [G14] | preference, usage, session sync | packages/db/client.ts:63 |
| packages/threat-feed (manual CLI)  [G10] -> OSV and CISA KEV | querybatch, advisory records, KEV json | packages/threat-feed/feeds.ts:6-9 |
| packages/threat-feed (manual CLI)  [G10] -> GitHub (api.github.com and gh) | lockfile reads; one issue per repo | packages/threat-feed/issues.ts |
| board-plane + board-vessel (Fly) -> Discord REST | Discord messages | packages/board-plane/discord-rest.ts:8 |
| board-plane + board-vessel (Fly) -> Board plane and model proxy (Fly) | wss control plane, model proxy | fly.toml |
| apps/linkedin-vessel (Fly) -> LinkedIn API | campaign calls | apps/linkedin-vessel/src/linkedin-api.ts |
| packages/control-plane  [G06] -> Stripe  [G06] | webhook events (no caller) | packages/control-plane/stripe-webhook.ts |
| packages/qdrant-client  [G06] -> Qdrant  [G06] | stub only | packages/qdrant-client/README.md |
| packages/voice + tools/speak.ts -> whisper.cpp + sox | mic audio to whisper.cpp | packages/voice/index.ts:1-4 |
| packages/voice + tools/speak.ts -> OpenAI cloud transcription | audio to transcript, cloud fallback | packages/voice/cloud-transcriber.ts |
| packages/voice + tools/speak.ts -> say, KittenTTS (Python), Termux TTS, moshi-mlx | text to spoken audio | packages/voice/tts-engine.ts:31 |
| packages/voice + tools/speak.ts -> ElevenLabs | placeholder, not implemented | packages/voice/tts-engine.ts:7 |
| packages/music (DJ) -> mpv + yt-dlp | stream URL, IPC volume | packages/music/dj.ts:5-8 |
| packages/deck, film-craft, table/bake -> ffmpeg | frames and audio to mp4 | packages/tools/video-deck.ts |
| packages/deck, film-craft, table/bake -> ImageMagick (magick) | title cards and grade | packages/film-craft/index.ts:4 |
| packages/eight (the 8gent loop) -> ripgrep | locate query | packages/ast-index/locate.ts:26 |
| packages/eight (the 8gent loop) -> cliclick, osascript, screencapture | click, type, screenshot | packages/hands/index.ts |
| packages/eight (the 8gent loop) -> Chrome | layout_compare renders HTML | packages/tools/layout-compare.ts |
| packages/eight (the 8gent loop) -> browser-use CLI (Python) | browser_* tool calls | packages/eight/tools.ts |

### View 3: outputs

| Box | Kind | Source path |
|---|---|---|
| 8gent runtime | daemon | packages/daemon/data-dir.ts:20 |
| sessions/<id>.jsonl | out | packages/specifications/session/writer.ts:37 |
| sessions/durable/<key>.jsonl | out | packages/specifications/session/durable-ledger.ts:65 |
| sessions/<id>/ (packed tool outputs) | out | packages/eight/ag|ent.ts:4857 |
| turns/<session>/<n>.json  [G11] | gap | packages/eight/turn-journal.ts:59 |
| timetravel/blobs + sessions/<id>/checkpoints.jsonl | out | packages/eight/timetravel/checkpoint-store.ts:229 |
| daemon.log, tui.log, debug.log | out | packages/eight/bug-report.ts:130 |
| logs/tools.log | out | packages/core/shell.ts:176 |
| memory/memory.db | out | packages/memory/index.ts:321-328 |
| memory/shared-memory.db | out | packages/memory/bus.ts:359 |
| memory/memory.db.enc, telegram-sessions*.json | out | packages/memory/telegram-memory-vault.ts:99 |
| table/table.db | out | packages/table/store.ts:60 |
| cron.json  [G13] | gap | packages/daemon/cron.ts:35 |
| runs.jsonl | out | packages/reporting/runlog.ts:92 |
| permissions-audit.jsonl | out | packages/permissions/user-policy.ts:51 |
| approvals-audit.jsonl | out | packages/daemon/channel-approvals.ts:111 |
| settings.json | out | packages/settings/index.ts:4 |
| providers.json, user.json | out | packages/eight/ag|ent.ts:431 |
| keys.env and secrets/ | out | packages/self-autonomy/onboarding.ts:627 |
| mcp.json | out | packages/mcp/config.ts:57 |
| hooks.yaml, hooks.json | out | packages/hooks/index.ts:145 |
| extensions/, skills/, prompts/ | out | packages/permissions/path-guard.ts:90 |
| tasks.json | out | packages/tasks/index.ts:5 |
| usage.json | out | packages/providers/usage-monitor.ts:33 |
| router.json | out | packages/ai/task-router.ts:65 |
| locality.jsonl | out | packages/providers/locality.ts:98 |
| update-check.json | out | packages/eight/update-notice.ts:111 |
| bug-reports/ | out | packages/eight/bug-report.ts:97 |
| browser-shots/ | out | packages/eight/tools.ts:5263 |
| creative/ | out | packages/music/dj.ts:168 |
| daemon-state.json, sessions-journal.json | out | packages/daemon/session-journal.ts |
| post-message.log | out | packages/ai/post-message.ts:221 |
| mesh/ | out | packages/orchestration/ag|ent-mesh.ts:112 |
| models/whisper/ | out | packages/voice/model-manager.ts:5 |
| kernel/training/ (off by default) | out | packages/kernel/personal-collector.ts:49 |
| security/threat-feed/<date>/  [G10] | gap | packages/threat-feed/README.md |
| evidence/  [G12] | gap | apps/tui/src/components/IntroBanner.tsx:2 |
| source files | app | packages/eight/tools.ts |
| git commits | app | packages/eight/commit-gate.ts:8 |
| .gitignore line | app | packages/memory/project-state.ts:91 |
| .8gent/worktrees/ | app | packages/orchestration/worktree-manager.ts:32 |
| .8gent/state.db | app | packages/db/src/workspace-db.ts:4 |
| decks, PDFs, game scaffolds | app | packages/deck/auto.ts |
| Telegram messages | ext | packages/daemon/telegram-bridge.ts |
| Slack and Discord posts | ext | packages/daemon/slack.ts:138 |
| GitHub issues and PRs | ext | packages/toolshed/tools/github/github-tools.ts |
| Vercel deployments | ext | packages/eight/tools.ts:2027 |
| Convex sync | ext | packages/db/client.ts:63 |
| Hosted judge calls | optin | packages/g8way/README.md:63-70 |
| npm package | entry | .github/workflows/release.yml:29-37 |
| GitHub Release + binaries | entry | .github/workflows/release-binaries.yml |
| deb, rpm, Windows installer | entry | packaging/linux/nfpm.yaml |
| winget manifests | entry | packaging/winget/8GIFoundation.8gentCode.yaml |
| spoken audio | daemon | packages/tools/speak.ts |
| mp4 decks and films | daemon | packages/tools/video-deck.ts |
| music playback | daemon | packages/music/dj.ts |
| G10 threat-feed is manual and its report is read by nobody | gap | packages/threat-feed/cli.ts |
| G11 Turn journal is written every turn, read only by a script | gap | packages/eight/turn-journal.ts:59 |
| G12 ~/.8gent/evidence has no writer in the repo | gap | apps/tui/src/components/IntroBanner.tsx:2 |
| G13 Two cron schedulers share one cron.json | gap | packages/cron/index.ts:86 |

| Arrow (from -> to) | What flows | Source path |
|---|---|---|
| 8gent runtime -> sessions/<id>.jsonl | appends and fsyncs; atomic writes for state files | packages/specifications/session/writer.ts:37 |
| 8gent runtime -> source files | tool calls after permission checks | packages/eight/tools.ts |
| 8gent runtime -> Telegram messages | replies and notifications | packages/daemon/telegram-bridge.ts |
| 8gent runtime -> npm package | tag push runs the release workflow | .github/workflows/release.yml:29-37 |
| 8gent runtime -> spoken audio | speak tool | packages/tools/speak.ts |

### View 4: gaps

| Box | Kind | Source path |
|---|---|---|
| G01 Android/Termux daemon unverified (#4852) | gap | packages/daemon/service.ts:450-455 |
| G02 Fly eight-vessel runs board-vessel, not the daemon | gap | fly.toml |
| G03 macOS launchd service never exercised in CI | gap | packages/daemon/service.e2e.test.ts:14-17 |
| G04 Three compiled targets have no smoke test | gap | scripts/build-binaries.ts:66-72 |
| G05 Swift apps have no release job | gap | .github/workflows/swift-nightly.yml |
| G16 g8way has no deploy unit in infra | gap | packages/g8way/README.md |
| G06 Dead or stub packages | gap | packages/dreams |
| G07 packages/tools: 62 of 96 modules have no importer | gap | packages/tools/crc32.ts |
| G08 Orphan files inside packages/eight | gap | packages/eight/auto-commit.ts |
| G09 Packages with source and zero tests | gap | packages/auth |
| G10 threat-feed is manual and its report is read by nobody | gap | packages/threat-feed/cli.ts |
| G11 Turn journal is written every turn, read only by a script | gap | packages/eight/turn-journal.ts:59 |
| G12 ~/.8gent/evidence has no writer in the repo | gap | apps/tui/src/components/IntroBanner.tsx:2 |
| G13 Two cron schedulers share one cron.json | gap | packages/cron/index.ts:86 |
| G19 Four Telegram code paths | gap | packages/daemon/telegram-bridge.ts |
| G14 Convex backend is not in this repo | unv | apps/convex/_generated/api.ts |
| G17 '8gate' is not a module; 8J is opt-in behind g8way | unv | packages/eight/provider-choice.test.ts |
| G18 Stub web apps: root src/ and apps/debugger | unv | src/Counter.tsx |
| G15 Docs name apps and counts the tree does not have | gap | README.md:608-609 |

| Arrow (from -> to) | What flows | Source path |
|---|---|---|
