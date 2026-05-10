# 8gent Code: Roadmap

Living document. Last updated 2026-05-10.

## Recently shipped

### Eyes (perception capability) - shipped 2026-05-09 / 2026-05-10

Body-part sibling to hands. Eyes perceive what's on screen; hands act on what eyes locate. Spec lives at `docs/specs/EYES-SPEC.md`; backend rationale at `docs/specs/EYES-BACKEND-AX-NATIVE.md`.

| # | Module | PR | Tests | Notes |
|---|--------|----|-------|-------|
| 2496 | Spec + decisions (capture, annotate, locate, describe, wait_for, diff, observe; permission model; failover chain) | #2497 + #2500 | n/a (spec PRs) | RFC §8 closed: logical coords + Frame.scale, focused-display default, 2s/16-frame annotation cache, perception:remote tier on data egress, macOS-first cross-platform path |
| 2501 | Peekaboo subprocess backend (v0, dropped 2026-05-10) | #2502 | 25 | Replaced by bundled native AX bridge - see row below |
| - | Native AX bridge backend: bundled Swift helper at `~/.8gent/bin/8gent-ax-bridge`; full Eyes impl, annotation cache, perception:remote tier with audit logging; no Homebrew dependency | this PR | 8 | Conceptual ancestry: Peekaboo (MIT, Peter Steinberger) - see `packages/eyes/native/NOTICE`. Build via `bash packages/eyes/native/build.sh`. |
| 2499 | Main lint debt cleared (3 Biome errors blocking CI) | #2509 | n/a | Unblocks clean CI on all downstream PRs |
| 2504 | Agent tool wiring: `eyes_see`, `eyes_find`, `eyes_describe`, `eyes_wait_for` + `perception` category in tool-registry | #2511 | (delegated to backend) | Singleton Eyes per process; v0 wired to local Ollama only |
| 2503 | `apps/8gent-eyes` headless CLI per spec §6 (dispatch-everywhere): 7 subcommands + `--intent` routing, AgentCLIDesign-compliant exit codes | #2513 | 9 | Token-cheap JSON-out default, no telemetry beyond audit |
| 2512 | Vision-router wiring: shared `eyesVisionProvider` for both Ollama (local) and OpenRouter (remote); two-phase VisionProvider contract closes #2508 privacy bug (resolve-then-tier-check-then-call) | #2524 | +1 (denial-without-inference) | `packages/ai/eyes-vision-provider.ts` is canonical adapter; both agent tool and CLI consume it |
| 2525 | Real perceptual diff replaces v0 byte-equality: pngjs-based, downscale-then-flood-fill, ~144ms on 4K, returns true changed-region bboxes for `observe()` events | #2528 | +6 | Logical-coord conversion via `Frame.scale`; threshold + downscale + minRegionPixels named constants |

To use end-to-end on macOS:

```bash
bash packages/eyes/native/build.sh    # one-time build of the bundled AX bridge (also runs on `bun install` outside CI)
# Grant Screen Recording + Accessibility entitlements in System Settings
ollama pull qwen2.5-vl                # local vision; OR set OPENROUTER_API_KEY for remote (requires perception:remote grant)
```

Open follow-ups (not blocking the capability):

- **#2510** keychain test crashes on Linux CI (P2). Currently the only thing keeping Validate red on every eyes PR.
- **Tail (no issue yet):** hands.screenshot migration into eyes per spec §9; Windows UIA backend; Linux X11 + Wayland backends per §8.5 ordering. (Real perceptual diff shipped via #2528 above; no longer in tail.)



### Handeyes (sensorimotor coordination, third body-part) - shipped 2026-05-10

The third body-part. Where hands is motor-only and eyes is perception-only, handeyes is the only package in the spine that depends on both. Default path stays the cheap sequential one (`eyes.find` → `hands.click`); the coordinator engages selectively when one of four triggers fires. Architecturally a thin coordinator over the existing `spawn_agent` / `check_agent` / `message_agent` / `merge_agent_work` primitives - no new orchestration substrate. Spec lives at `docs/specs/HANDEYES-SPEC.md`; all five §8 RFC items resolved as decisions.

| # | Module | PR | Tests | Notes |
|---|--------|----|-------|-------|
| 2526 | Spec + contract scaffold (interface, types, adapter registry) | #2531 | n/a (scaffold PR) | Contract surface in `packages/handeyes/index.ts` + `types.ts`; locked before the loop landed |
| 2527 | DoomLoopDetector EventEmitter hook (RFC Option A): `detector.on("stuck", DoomStuckEvent)` for push-style cycle detection. Closes HANDEYES-SPEC §8 Q3. | #2534 | +7 | Sync `check(): boolean` API preserved unchanged for backward compat |
| 2526 | Engagement loop: 3 in-loop trigger detectors (find-zero-hits-twice, wait-for-timeout, click-no-change), DoomLoopDetector subscription via typed `.on('stuck', ...)`, struggle-mode lifecycle (open / step / forward-progress streak / ttl exhaustion / explicit / sub-agent error), per-trigger cooldown on exit | this PR | 39 | `packages/handeyes/engagement-loop.ts`. Defaults: ttl=8 steps, forward-progress streak=3, cooldown=1.5s, material-change similarity=0.95 |
| - | Eyes worker (in-process wrapper around `eyes.observe()` publishing diff events to the orchestrator bus under `handeyes:{sessionId}:observation`) + Hands queue (FIFO motor-call serialisation, mid-click animation re-locate per spec §7.1) | this PR | (covered by 39) | `packages/handeyes/eyes-worker.ts`, `packages/handeyes/hands-queue.ts` |
| - | Orchestrator-backed Handeyes impl wiring all five contract methods + adapter registration via `configureOrchestratorAdapter()` (lazy, avoids cycle with `index.ts`) | this PR | (covered by 39) | `packages/handeyes/handeyes-impl.ts` |
| - | Agent tool wiring: `handeyes_locate_and_click`, `handeyes_click_and_verify`, `handeyes_type_and_confirm`, `handeyes_engage_struggle_mode`, `handeyes_exit_struggle_mode` + `coordination` category in tool-registry | this PR | (delegated to backend) | Lazy singleton `getHandeyes()` so eyes / hands boot cost is paid only when handeyes engages |

Trigger 3 ("click followed by no observe-detected screen change") fires reliably on the real perceptual diff shipped in #2528 (above). Trigger 4 ("DoomLoopDetector caught a cycle") is duck-typed against the detector's `'stuck'` event so the engagement loop is independent of the agent loop's detector wiring schedule; coordinator built against an older detector simply receives no trigger-4 fires while the other three triggers still fire.

Open follow-ups (not blocking the capability):

- **Tail (no issue yet):** `apps/8gent-handeyes` headless CLI for `--intent` parity with `apps/8gent-eyes`; trace-store `session_id` column wiring per spec §8.5; promote tools out of the `coordination` discovery category once trigger-fire rate stabilises post-launch.



### v0.14 "Hardened Kernel" (rc - bundling for release per #2485)

Concept extraction from StartupHakk/OpenMonoAgent (AGPL) under CleanRoomPort discipline. No source copied. Boardroom-ratified 2026-05-09 with 5 binding amendments. Minutes at `docs/boardroom-minutes/2026-05-09-openmonoagent-extraction.md`.

| # | Module | PR | Tests |
|---|--------|----|-------|
| 2461 | DoomLoopDetector hardening - period-1 to period-4 cycle detection on a 12-call sliding window | #2472 | 13 |
| 2464 | SecretScanner - scrubs AWS / GCP / Anthropic / OpenAI / DigitalOcean / GitHub / Slack secrets from tool output before model sees | #2477 | 53 |
| 2465 | PathGuard - static deny-list for ~/.ssh, ~/.aws, ~/.kube + UNC + device files, runs before NemoClaw | #2476 | 30 + 1049 pkg |
| 2462 | ToolResultCache - LRU 500 / 30-min TTL / mtime-validated for read-only tools | #2478 | 13 |
| 2463 | ArtifactStore - outputs >50KB persisted to disk, model gets `[ARTIFACT a3f9 132KB]` reference | #2479 | 19 |
| 2471 | PreToolRouter - deterministic harness routing of retrieval strategy, model-agnostic | #2480 | 14 |
| 2467 | TwoStageCompactor - 65% checkpoint + 80% hard compact | #2481 | 8 + 107 pkg |
| 2470 | TurnJournal - per-turn replayable JSON record at `~/.8gent/turns/{sessionId}/{turnIndex}.json` | #2482 | 13 |
| 2466 | BashParser - parses bash into segments + redirections + subshells (recursion capped at 50) so policy engine evaluates per-subcommand | #2483 | 23 + 93 pkg |

Closed without implementation:
- #2468 AgentDefinition consolidation - closed not-applicable. Our `packages/orchestration/subagent.ts` uses ad-hoc `SubAgentConfig` per spawn, not Anthropic-style named profiles. Nothing to consolidate.
- #2469 AnsiPainter renderer - strategic note, NOT-TO-BUILD. Multi-month rewrite deferred until Ink limitations cost measurable user-visible UX.

### v0.13.0 (2026-04-30)

TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar). Capability tiers, sqlite-vec memory, app archive format, tmux backend. Hotkeys: Ctrl+Y cycles modes, Ctrl+T new-tab.

## Next

### v0.14 launch bundle (#2485)

Per 8MO Zara boardroom recommendation 2026-05-09:
- [ ] CHANGELOG.md entry (DONE - see CHANGELOG.md `[Unreleased]`)
- [ ] One launch post (Substack + LinkedIn + X + Threads)
- [ ] One 60s AdPitchVideo demoing doom-loop protection live
- [ ] Update 8gent.dev landing with new positioning bullet
- [ ] Tag and release: `git tag v0.14.0` + `npm publish`

### Follow-ups from v0.14 extraction

- **#2484** wire `gateBashCommand` from BashParser into the runtime spawn site in `packages/eight/tools.ts`. Karen's flag - primitive shipped + tested, runtime integration deferred per blast-radius rule.
- **#2473** built-in slash command registry race on TUI startup (silent fallthrough). P0.
- **#2474** TUI frame buffer corruption (text from prior turns overlays new content). P0.

### Existing in flight

- **Per-tab model routing** - each agent tab (Orchestrator/Engineer/QA) gets its own provider and model, with Apple Foundation as lightweight chat option
- **Voice hardening** - KittenTTS integration, full-duplex Moshi backend stabilization
- **Documentation sweep** - aligning all docs, README, and live sites with audited feature set
- **PR cleanup** - merging pending PRs with verification

## Under evaluation

### #2486 Virtuoso + OPAL as federated-data-space substrate

1-week scoped spike, NOT a build commitment. Triggered by post-Scoble/Idehen video demo (2026-05-09) showing working federated knowledge-graph substrate with file-system + web + DB unification. Decision criteria filed in issue.

What we're testing:
- `mcp-odbc-server` and OPAL MCP in our MCP client registry as a sandboxed test
- Virtuoso open edition (GPL - process-boundary safety verification critical)
- NL→SPARQL bridge vs. our existing PreToolRouter (#2480)
- Federated query across `~/8gent-code/docs/`, `~/8gi-governance/docs/`, agent-mail SQLite, TurnJournal JSON files vs. ad-hoc grep+jq

Outcomes will land as a separate issue: GO (build adapter), STAY-AT-WATCH, or NO-GO.

Watch note at `~/8gi-governance/docs/openlink-virtuoso-watch.md`.

## Later

- **MCP server support** - expose 8gent tools as MCP servers for external agent consumption
- **Extension system** - ExtensionCrafter for autonomous source-to-extension generation
- [HyperAgent meta-improvement loop](docs/HYPERAGENT-SPEC.md)
- [Kernel fine-tuning pipeline](docs/KERNEL-FINETUNING.md) activation
- Desktop client (Swift AppKit, `apps/lil-eight/`)
- Multi-tenant control plane via 8GI gateway
- Full autonomous issue resolution
- Personal LoRA from session training pairs
- Dead code cleanup (music/DJ package)

## Process amendments

### #2475 Boardroom-before-dispatch on >3-issue extractions

Constitutional amendment ratified 2026-05-09. Any multi-agent extraction project, refactor, or feature touching MORE THAN 3 GitHub issues now requires:
1. Boardroom alignment (8 officers brief + converge) BEFORE Wave 1 dispatch
2. Signed PRD or boardroom-minutes file capturing the 8 positions and converged decision
3. Minutes filed at `docs/boardroom-minutes/{date}-{slug}.md`

Failure forces a PAUSE of in-flight work pending retrospective ratification.

### CleanRoomPort skill

Located at `~/.claude/skills/CleanRoomPort/SKILL.md`. Enforces:
- No source copy from copyleft (AGPL/GPL/SSPL/FSL/BUSL) repos
- Test-first: write tests from acceptance criteria BEFORE implementation
- Branch from `origin/main`, not local main (avoids stale-branch incidents)
- TUI off-limits unless issue explicitly says otherwise (protects shipped TUI work)
- No `Co-Authored-By` trailers, no AI vendor names, no em dashes in commit messages
- Sub-300 LOC per port (forces minimal scope)
- Mandatory PR credit line citing the source repo + license
