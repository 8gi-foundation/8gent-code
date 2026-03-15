# Changelog

All notable changes to 8gent Code will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **`@8gent/kernel` package** — full 4-phase RL fine-tuning pipeline via MetaClaw
  - **Phase 1: Proxy manager** (`proxy.ts`) — start/stop MetaClaw, health checks, latency overhead monitoring with configurable threshold
  - **Phase 2: Judge scoring** (`judge.ts`) — PRM wiring via Gemini Flash (free), score distribution tracking, per-model stats, daily trend analysis
  - **Phase 3: Training orchestration** (`training.ts`) — GRPO batch collection with score filtering, checkpoint creation, benchmark validation gate, auto-rollback on regression
  - **Phase 4: Production loop** (`loop.ts`) — MadMax scheduling (sleep/idle windows), auto-promotion of improved checkpoints into model-router, health monitoring, score trend alerts
  - **Kernel manager** (`manager.ts`) — unified entry point, reads `.8gent/config.json`, safe no-op when disabled
- **MetaClaw RL fine-tuning exploration** — architecture doc, proxy config, and integration plan for continuous GRPO fine-tuning of local Ollama models via MetaClaw
- **MetaClaw proxy toggle** — `METACLAW_PROXY_URL` env var and `.8gent/config.json` metaclaw section to route Ollama calls through MetaClaw's OpenAI-compatible proxy
- **RL checkpoint validation gate** — `benchmarks/autoresearch/validate-checkpoint.ts` runs benchmark suite against fine-tuned models and compares against baseline scores to prevent regressions
- **Kernel Fine-Tuning section in README** — documents proxy architecture, base model recommendations, and how to enable

## [0.5.0] — 2026-03-14

### Added
- **Universal BMAD planning** — system prompt now classifies tasks as Code, Creative, Research, Planning, or Communication with tailored approaches for each
- **Proactive planner wired into agent loop** — updates prediction context on every tool call, tracks modified files and errors
- **Evidence collection in agent core** — fire-and-forget evidence gathering after file writes, commands, and git commits; session summary on finish
- **AST `indexFolder()` implementation** — recursively parses TS/JS files, populates symbol maps and file outlines
- **AST `getSymbolSource()` implementation** — reads file and extracts lines for a specific symbol with optional context
- **AST `estimateTokenSavings()` implementation** — calculates full-file vs symbol-only token estimates
- **Momentum tracking** in ProactivePlanner — tracks steps completed, rate (steps/min), and streak
- **Universal step categories** — added `creative`, `research`, `communication`, `planning` to StepCategory
- **Creative/research prediction methods** — `predictCreativeSteps()` and `predictResearchSteps()` for non-code tasks
- **REPL commands**: `/board` (kanban view), `/predict` (confidence-scored predictions), `/momentum` (velocity stats)
- **bmad-method** as devDependency (v6.1.0) with auto-init on postinstall

### Fixed
- `EvidenceCollector` constructor now accepts optional config with `process.cwd()` default (was required, crashed without args)
- `PredictionContext.currentPlan` type inlined (was referencing undefined `ExecutionPlan`)
- `indexRepo()` now throws descriptive error instead of generic "Not implemented"
- Removed `...config` spread in EvidenceCollector that was overwriting defaults

### Changed
- Version bump to 0.5.0 (new features: BMAD wiring, evidence, AST, momentum)

---

## [0.3.1] — 2026-03-14

### Added
- Agent mode cycling (Ctrl+T): Planning, Researching, Implementing, Testing, Debugging
- Kanban auto-population from agent PLAN: output — parses numbered steps into cards
- Kanban auto-advancement: Ready → In Progress on tool start, → Done on tool end
- Dynamic model fetching per provider (Ollama, OpenRouter, LM Studio)

### Fixed
- ADHD mode toggle (stale closure — only toggled on, never off)
- Scroll jumping — removed overflow:hidden, capped visible messages to 50
- Re-planning loop — agent now plans once then executes immediately
- Replaced "Demoing" mode with "Debugging"

---

## [0.3.0] — 2026-03-14

### Added
- **packages/eight/** — New core agent engine (replaces packages/agent/)
  - Non-blocking agent with always-visible input and message queue
  - Real-time streaming of assistant reasoning into chat
  - Ollama, LM Studio, and OpenRouter client modules
  - Context engineering and prompt system
  - Full REPL with tool loop
- **packages/ai/** — Vercel AI SDK integration
  - ToolLoopAgent with multi-turn conversation support
  - Provider abstraction (Ollama, OpenRouter, LM Studio)
  - Toolshed bridge for dynamic tool loading
- **packages/harness-cli/** — Headless CLI for running and inspecting 8gent sessions
  - `harness run` / `harness inspect` / `harness doctor` / `harness sessions`
- **packages/specifications/** — Session spec v2 with full AI SDK data model
  - JSON schema, reader, writer for session persistence
- **apps/debugger/** — Next.js session debugger app
  - Session list, viewer, streaming, copy-as-JSON
- **benchmarks/** — Full v2 benchmark suite (39 benchmarks, 7 categories)
  - Autoresearch harness with Ollama + OpenRouter fallback
  - Experience-based model router (learns best model per domain)
  - Execution grader (SWE-bench style, 70% exec + 30% keyword)
  - 15 battle-test benchmarks across professional domains
  - Prompt mutation system with failure analysis
  - Overnight runner for continuous improvement
- **packages/dreams/** — Creative scripts for video generation
- **TUI overhaul**
  - Design-system-first architecture with primitives layer
  - Process sidebar (Ctrl+B) for background tasks
  - useLayout hook for centralized panel/pane state
  - Theme tokens and semantic color system
  - Pinned process sidebar with overflow scroll fix
- `8` CLI alias (short for `8gent`)
- Background task auto-promotion for long-running commands
- Spatial awareness and "orient first" rules in system prompt
- Loop detection and lightweight run log

### Changed
- **Breaking:** `packages/agent/` renamed to `packages/eight/`
- Agent now uses Vercel AI SDK ToolLoopAgent instead of raw fetch
- Session spec upgraded to v2 (incompatible with v1 sessions)
- System prompt refined with scaffolding guidance, dev server warnings
- All TUI components migrated from raw colors to design system primitives

### Fixed
- .env loading from repo root and ~/.8gent when running from another directory
- Tool call visibility in message stream
- Command failures now shown inline
- list_files no longer hides directories
- JSON tool format removed from prompt (uses native function calling)

### Battle Test Scores (v0.3.0)
| Benchmark | Domain | Score |
|-----------|--------|-------|
| BT001 | Auth System | 94 |
| BT002 | Event Architecture | 92 |
| BT003 | Data Pipeline | 100 |
| BT005 | State Machine | 92 |
| BT007 | SEO Audit | 96 |
| BT011 | Video Production | 100 |
| BT012 | Music Theory | 81 |
| BT014 | AI Consulting | 95 |

---

## [0.2.0] — 2026-03-10

### Added
- OpenRouter provider wired into TUI and agent runtime
- Benchmark suite v1 (bug-fixing, file-manipulation, feature-implementation)
- Autoresearch loop (Karpathy methodology)
- Few-shot examples per benchmark category
- Temperature sweep (0.3, 0.5, 0.7)
- Fullstack benchmarks (FS001-FS003, FS-MEGA-001)
- Agentic benchmarks (TC001, DP001, RE001, SD001, AR001, CB001, MR001)
- UI design benchmarks (UI001-UI008)
- Reporting module with token savings calculator

### Changed
- Prompt mutation system with deduplication (exact + 70% word overlap)

---

## [0.1.0] — 2026-02-28

### Added
- Initial release
- Ink v6 TUI with chat interface
- Ollama integration (local LLM inference)
- Basic tool system (file read/write, shell commands)
- System prompt with coding agent persona
- Demo savings calculator
