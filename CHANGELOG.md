# Changelog

All notable changes to 8gent Code will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **GitHub integration** — `packages/auth/github.ts` for GitHub provider token management (Keychain/encrypted storage), `packages/auth/github-tools.ts` with REST API helpers (repos, issues, PRs, branch detection), `/github` slash command in TUI, `/auth status` now shows GitHub connection info, auto-configures `gh` CLI after login
- **Tenant Convex persistence** — `tenants` table in Convex schema with CRUD mutations, `ConvexTenantStore` with in-memory fallback
- **Automatic Convex session sync** — `SessionSyncManager` batches token/tool-call deltas, flushes every 10s, fire-and-forget
- **`syncToConvex` config flag** — enable/disable Convex session sync in `.8gent/config.json`
- **Real Stripe billing** — real SDK calls replacing all stubs, webhook signature verification, Hono+Express handlers, lazy init (free tier never loads Stripe)
- **Knowledge graph** — SQLite entity/relationship store with BFS traversal, heuristic extraction from tool results, user preference detection, fire-and-forget ingestion
- **Memory v2** — SQLite+FTS5+embeddings replacing JSONL, 5 memory types, hybrid search, knowledge graph tables, version history, v1 migration

## [0.7.0] — 2026-03-18

### Added
- **Smart onboarding** — auto-detects git config, Ollama models, GitHub auth; reduces from 8 questions to 3
- **Preferences cloud sync** — `PreferencesSyncManager` pulls/pushes preferences via Convex after auth; `updatedAt` wins merge strategy
- **Adaptive system prompt** — `USER_CONTEXT_SEGMENT` injects user name, role, communication style into system prompt
- **Session history & resume** — `/history`, `/continue`, `/resume`, `/compact` slash commands; checkpoints every 5 messages
- **Conversations table** — Convex schema for cross-device session persistence with checkpoint data
- **Personal LoRA collector** — `PersonalCollector` quality-filters session traces for fine-tuning (score >= 0.7, no corrections)
- **ESC to interrupt** — pressing Escape during generation aborts the AI SDK stream immediately
- **User-scoped memory** — `userId` field on `MemoryBase` and `SearchOptions` for per-user memory recall
- **HistoryScreen** — TUI screen for browsing and resuming past sessions with keyboard navigation
- **Comprehensive personalization docs** — `docs/PERSONALIZATION.md` covering all 5 phases

## [0.6.0] — 2026-03-17

### Added
- **`apps/clui/` — Tauri 2.0 desktop overlay** — branded 8gent desktop app with Alt+Space toggle, multi-tab sessions, transparent floating overlay, Rust backend for process management, React 19 frontend with Tailwind CSS 4, real-time NDJSON streaming from agent subprocess, permission server for human-in-the-loop tool approval
- **`packages/auth/` — Clerk authentication** — device code flow for CLI login (`8gent auth login`), macOS Keychain token storage with AES-256-GCM encrypted file fallback, JWT validation via `jose`, automatic token refresh, non-blocking anonymous mode (auth never blocks local usage)
- **`packages/db/` — Convex database** — reactive database with users, sessions, usage, and preferences tables; real-time sync; Clerk auth integration; offline mutation queuing; ConvexClient wrapper for Bun
- **`packages/voice/` — Speech-to-Text via Whisper** — local transcription via whisper.cpp CLI (no cloud dependency), sox-based mic recording, model manager with streaming downloads from Hugging Face (tiny/base/small), voice activity detection, OpenAI Whisper API cloud fallback, VoiceEngine with EventEmitter API
- **`packages/control-plane/` — Multi-tenant management** — tenant provisioning with subdomain routing (username.8gent.app), usage analytics, billing plan definitions (free/pro/team), Stripe integration stubs, admin dashboard data layer
- **`apps/dashboard/` — Admin dashboard** — Next.js 16 admin panel with Clerk auth + RBAC, user management with search/filter, session monitoring, usage charts (recharts), system health, model distribution, plan management
- **CLUI integration components** — ThinkingView, EvidencePanel, PlanKanban, AuthGate, SettingsPanel adapted from TUI to React DOM with Framer Motion animations
- **TUI voice components** — `useVoiceInput` hook (Ctrl+Space toggle) and `VoiceIndicator` component with recording status, audio levels, and download progress
- **CLI auth commands** — `8gent auth login`, `8gent auth logout`, `8gent auth status`, `8gent auth whoami`
- **20 BMAD planning documents** — project briefs, PRDs, architecture docs, and epics for all 5 phases across `docs/bmad/`
- **Local vision & OCR model support** — vision router now auto-discovers OCR-specialized models (dots.ocr, deepseek-ocr, glm-ocr) alongside general vision models (qwen2.5-vl, minicpm-v, internvl2)
- **`/vision` slash command** — configure vision/OCR models from TUI: `/vision status`, `/vision model <name>`, `/vision ocr <name>`, `/vision pull` for recommendations
- **Vision config in `.8gent/config.json`** — user-configurable `defaultModel`, `ocrModel`, fallback chains, provider preference (local/cloud), timeout
- **OCR-specific routing** — `findOCRModel()` prefers dedicated OCR models for text extraction, falls back to general vision models with strong OCR
- **OCR prompt in VisionInterpreter** — dedicated OCR prompt preserves formatting, tables, code indentation, and LaTeX formulas
- **OpenRouter free vision fallback** — vision router now checks OpenRouter free models even without API key as additional fallback

### Fixed
- **Installer color violations** — replaced forbidden `color="gray"` and `color="white"` with `dimColor` and default text in `apps/installer/src/index.tsx`
- **write_file path bug** — models sometimes pass absolute-looking paths like `/8gent-code/server.ts` that resolve outside the working directory; these are now auto-stripped to relative paths instead of throwing a path-traversal error; tool description and system prompt updated to instruct models to use relative paths

### Added
- **Dynamic free model router** — `getBestFreeModel()` in `packages/providers/index.ts` queries OpenRouter's `/api/v1/models` endpoint to find the best available free model (filtered by `:free` suffix, sorted by context length); results cached for 1 hour; `spawn_agent` now accepts `model: "auto:free"` to automatically pick the best free model
- **Evidence collection visible in TUI** — real-time evidence badges (pass/fail) appear in the chat stream after write_file, edit_file, run_command, and git_commit; one-line summary shown at end of each response; `/evidence` command shows full session breakdown with per-type counts
- **Three-layer model architecture** — base model (qwen3) + Eight LoRA (centralized training from benchmarks) + Personal LoRA (user's local fine-tune on their patterns); personal module retrains when a new Eight version releases
- **Eight model version manager** (`version-manager.ts`) — manages model promotion lifecycle with naming convention `eight-{major.minor.patch}-q{gen}:{params}`, Gemini Flash judge validates checkpoints before promotion
- **8gent as default provider** — `eight-1.0-q3:14b` is now the primary recommended model across all documentation and quick-start guides
- **Auto-open files on macOS** — files referenced in agent output are opened automatically in the default editor
- **TUI accepts any model name** — `/model` command now accepts arbitrary model identifiers, not just predefined options

### Fixed
- **Security fixes ported to `packages/eight`** — hardened command execution, input sanitization, and permission checks carried over from agent package

### Added (prior)
- **`@8gent/kernel` package** — full 4-phase RL fine-tuning pipeline via training proxy
  - **Phase 1: Proxy manager** (`proxy.ts`) — start/stop training proxy, health checks, latency overhead monitoring with configurable threshold
  - **Phase 2: Judge scoring** (`judge.ts`) — PRM wiring via Gemini Flash (free), score distribution tracking, per-model stats, daily trend analysis
  - **Phase 3: Training orchestration** (`training.ts`) — GRPO batch collection with score filtering, checkpoint creation, benchmark validation gate, auto-rollback on regression
  - **Phase 4: Production loop** (`loop.ts`) — MadMax scheduling (sleep/idle windows), auto-promotion of improved checkpoints into model-router, health monitoring, score trend alerts
  - **Kernel manager** (`manager.ts`) — unified entry point, reads `.8gent/config.json`, safe no-op when disabled
- **RL fine-tuning exploration** — architecture doc, proxy config, and integration plan for continuous GRPO fine-tuning of local Ollama models via training proxy
- **Training proxy toggle** — `TRAINING_PROXY_URL` env var and `.8gent/config.json` training_proxy section to route Ollama calls through the OpenAI-compatible training proxy
- **RL checkpoint validation gate** — `benchmarks/autoresearch/validate-checkpoint.ts` runs benchmark suite against fine-tuned models and compares against baseline scores to prevent regressions
- **Kernel Fine-Tuning section in README** — documents proxy architecture, base model recommendations, and how to enable
- **Remotion video demos** (`apps/demos/`) — React-based video generation for product reels and landing page content
  - 3 ready-to-render compositions: HeroIntro, FeatureShowcase, CostComparison
  - 9:16 vertical (reels) and 16:9 landscape variants for each
  - Reusable component library: Logo, TerminalWindow, GlowCard, CodeBlock, Background
  - Animation utilities: fade-in, scale-in, typewriter, glow pulse, counter
  - Branded design tokens matching 8gent visual identity
  - Scripts: `studio`, `render:hero`, `render:features`, `render:cost`, `render:all`
  - **Media preview page** (`bun run demos:media`) — Vite-powered browser preview with Remotion Player

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
