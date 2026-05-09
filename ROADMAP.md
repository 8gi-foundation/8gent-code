# 8gent Code — Roadmap

Living document. Last updated 2026-05-09.

## Recently shipped

### v0.14 "Hardened Kernel" (rc — bundling for release per #2485)

Concept extraction from StartupHakk/OpenMonoAgent (AGPL) under CleanRoomPort discipline. No source copied. Boardroom-ratified 2026-05-09 with 5 binding amendments. Minutes at `docs/boardroom-minutes/2026-05-09-openmonoagent-extraction.md`.

| # | Module | PR | Tests |
|---|--------|----|-------|
| 2461 | DoomLoopDetector hardening — period-1 to period-4 cycle detection on a 12-call sliding window | #2472 | 13 |
| 2464 | SecretScanner — scrubs AWS / GCP / Anthropic / OpenAI / DigitalOcean / GitHub / Slack secrets from tool output before model sees | #2477 | 53 |
| 2465 | PathGuard — static deny-list for ~/.ssh, ~/.aws, ~/.kube + UNC + device files, runs before NemoClaw | #2476 | 30 + 1049 pkg |
| 2462 | ToolResultCache — LRU 500 / 30-min TTL / mtime-validated for read-only tools | #2478 | 13 |
| 2463 | ArtifactStore — outputs >50KB persisted to disk, model gets `[ARTIFACT a3f9 132KB]` reference | #2479 | 19 |
| 2471 | PreToolRouter — deterministic harness routing of retrieval strategy, model-agnostic | #2480 | 14 |
| 2467 | TwoStageCompactor — 65% checkpoint + 80% hard compact | #2481 | 8 + 107 pkg |
| 2470 | TurnJournal — per-turn replayable JSON record at `~/.8gent/turns/{sessionId}/{turnIndex}.json` | #2482 | 13 |
| 2466 | BashParser — parses bash into segments + redirections + subshells (recursion capped at 50) so policy engine evaluates per-subcommand | #2483 | 23 + 93 pkg |

Closed without implementation:
- #2468 AgentDefinition consolidation — closed not-applicable. Our `packages/orchestration/subagent.ts` uses ad-hoc `SubAgentConfig` per spawn, not Anthropic-style named profiles. Nothing to consolidate.
- #2469 AnsiPainter renderer — strategic note, NOT-TO-BUILD. Multi-month rewrite deferred until Ink limitations cost measurable user-visible UX.

### v0.13.0 (2026-04-30)

TUI bottom-bar redesign (DjDeck, AgentInstrumentStrip, ModeFooter, HeaderBar, BottomBar). Capability tiers, sqlite-vec memory, app archive format, tmux backend. Hotkeys: Ctrl+Y cycles modes, Ctrl+T new-tab.

## Next

### v0.14 launch bundle (#2485)

Per 8MO Zara boardroom recommendation 2026-05-09:
- [ ] CHANGELOG.md entry (DONE — see CHANGELOG.md `[Unreleased]`)
- [ ] One launch post (Substack + LinkedIn + X + Threads)
- [ ] One 60s AdPitchVideo demoing doom-loop protection live
- [ ] Update 8gent.dev landing with new positioning bullet
- [ ] Tag and release: `git tag v0.14.0` + `npm publish`

### Follow-ups from v0.14 extraction

- **#2484** wire `gateBashCommand` from BashParser into the runtime spawn site in `packages/eight/tools.ts`. Karen's flag — primitive shipped + tested, runtime integration deferred per blast-radius rule.
- **#2473** built-in slash command registry race on TUI startup (silent fallthrough). P0.
- **#2474** TUI frame buffer corruption (text from prior turns overlays new content). P0.

### Existing in flight

- **Per-tab model routing** — each agent tab (Orchestrator/Engineer/QA) gets its own provider and model, with Apple Foundation as lightweight chat option
- **Voice hardening** — KittenTTS integration, full-duplex Moshi backend stabilization
- **Documentation sweep** — aligning all docs, README, and live sites with audited feature set
- **PR cleanup** — merging pending PRs with verification

## Under evaluation

### #2486 Virtuoso + OPAL as federated-data-space substrate

1-week scoped spike, NOT a build commitment. Triggered by post-Scoble/Idehen video demo (2026-05-09) showing working federated knowledge-graph substrate with file-system + web + DB unification. Decision criteria filed in issue.

What we're testing:
- `mcp-odbc-server` and OPAL MCP in our MCP client registry as a sandboxed test
- Virtuoso open edition (GPL — process-boundary safety verification critical)
- NL→SPARQL bridge vs. our existing PreToolRouter (#2480)
- Federated query across `~/8gent-code/docs/`, `~/8gi-governance/docs/`, agent-mail SQLite, TurnJournal JSON files vs. ad-hoc grep+jq

Outcomes will land as a separate issue: GO (build adapter), STAY-AT-WATCH, or NO-GO.

Watch note at `~/8gi-governance/docs/openlink-virtuoso-watch.md`.

## Later

- **MCP server support** — expose 8gent tools as MCP servers for external agent consumption
- **Extension system** — ExtensionCrafter for autonomous source-to-extension generation
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
