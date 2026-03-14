# Changelog

All notable changes to 8gent Code will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
