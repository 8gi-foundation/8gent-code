# 8gent CLUI -- Project Brief

**Author:** Business Analyst (BMAD Phase 1)
**Date:** 2026-03-16
**Version:** 1.0

---

## Vision

8gent CLUI transforms the existing 8gent terminal-only experience into a native desktop overlay application. Where the current TUI lives entirely inside a terminal emulator and requires users to context-switch away from their editor, CLUI provides a floating, always-available panel toggled with a single keystroke. The agent remains local-first, running Ollama/OpenRouter/LM Studio models through the existing `packages/eight` engine -- no cloud dependency, no usage caps.

The name "CLUI" (Command Line User Interface) signals that this is not a browser app or a SaaS dashboard. It is a native overlay that feels like part of the OS, closer to Spotlight or Raycast than to a web IDE.

---

## Goals

1. **Zero-friction access.** Alt+Space toggles the overlay from any application. No terminal juggling, no tmux splits.
2. **Multi-session concurrency.** Developers run multiple agent sessions in tabs -- one per task, repo, or experiment -- each backed by an independent 8gent subprocess.
3. **Human-in-the-loop safety.** Every tool call passes through a permission server with approve/deny UI, configurable auto-approve rules, and a full audit log.
4. **Preserve the engine.** CLUI does not rewrite the agent. It wraps `packages/eight` as a subprocess, consuming its NDJSON event stream. All 33 existing packages remain untouched.
5. **Tiny footprint.** Tauri 2.0 produces a 5-10 MB binary (vs 150 MB for Electron). The overlay adds negligible memory overhead on top of the Bun agent process.

---

## Target Users

### Primary: Solo Developers & Power Users

- Run local LLMs for privacy, cost, or latency reasons.
- Want an agent that is always one keystroke away while they work in VS Code, Cursor, or the terminal.
- Already use or are willing to install Ollama.
- Value keyboard-driven workflows and minimal UI chrome.

### Secondary: Small Engineering Teams

- Share 8gent configurations across a team (model presets, tool permissions, project memory).
- Use the audit log for compliance or code-review traceability.
- Need multi-session tabs to juggle feature branches simultaneously.

### Tertiary: AI Tooling Enthusiasts

- Experiment with model routing (Ollama local vs OpenRouter cloud fallback).
- Want a visual layer on top of the 8gent engine to understand what the agent is doing (ThinkingView, evidence badges, plan kanban).

---

## Key Differentiators from CLUI-CC

| Dimension | CLUI-CC (lcoutodemos) | 8gent CLUI |
|-----------|----------------------|------------|
| **Agent engine** | Claude Code CLI (Anthropic SaaS) | `packages/eight` (local LLMs, OpenRouter, LM Studio) |
| **Model lock-in** | Claude-only | Any model via Ollama, OpenRouter, or custom provider |
| **Runtime** | Electron 33 (~150 MB) | Tauri 2.0 (~5-10 MB), Rust backend |
| **Frontend** | React 19 in Electron renderer | React 19 in Tauri webview (shared components) |
| **Agent protocol** | `claude -p --output-format stream-json` | `bun run packages/eight/index.ts` with NDJSON events |
| **Component library** | Built from scratch | Adapted from 32+ existing Ink TUI components |
| **Design system** | Tailwind defaults | Ported design tokens (6 safe ANSI colors mapped to CSS vars) |
| **Plugin system** | Marketplace (planned) | Toolshed + Skills (already built in packages/toolshed, packages/skills) |
| **Fine-tuning** | None | RL training proxy pipeline (packages/kernel) |
| **Cost** | Anthropic API billing | Free with local models, pay-per-token with OpenRouter |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Overlay toggle latency** | < 200ms from keystroke to visible window | Instrumented in Rust hotkey handler |
| **Session spawn time** | < 1s from "new tab" click to ready prompt | Measured from IPC command to first NDJSON heartbeat |
| **Binary size** | < 15 MB (app bundle, no runtime) | `du -sh` on release build |
| **Memory overhead** | < 50 MB for CLUI shell (excluding agent subprocesses) | Activity Monitor / `ps` |
| **First-week adoption** | 50+ downloads from GitHub Releases | Release analytics |
| **Permission approval UX** | < 500ms from tool-call event to approval dialog visible | Instrumented in permission server |

---

## Constraints

1. **Bun runtime.** The agent subprocess must run via Bun. Tauri's Rust backend spawns `bun run ...` as a child process.
2. **Existing 33 packages.** CLUI must not fork or modify any existing package. It consumes `packages/eight` as a black-box subprocess.
3. **Design token parity.** The 6 safe ANSI colors (red, green, yellow, blue, magenta, cyan) and semantic roles (muted, success, warning, danger, accent, info, brand) must map 1:1 to CSS custom properties. No `gray`, `white`, or `black` hardcoded values.
4. **Cross-platform aspiration.** Tauri 2.0 supports macOS, Linux, and Windows. Phase 1 targets macOS; Linux and Windows follow in Phase 2.
5. **Monorepo workspace.** CLUI lives at `apps/clui/` and is registered in the root `workspaces` array. It shares no runtime dependencies with `apps/tui/` but may import type definitions.
6. **No Electron.** The decision is Tauri 2.0. Electron is explicitly rejected for binary size, memory usage, and philosophical alignment with 8gent's lightweight ethos.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Tauri 2.0 global hotkey flaky on Linux/Windows | Cross-platform delay | Phase 1 is macOS-only; test matrix in Phase 2 |
| Bun subprocess communication overhead | Latency in event streaming | NDJSON over stdout is zero-overhead; benchmark early |
| Ink components not trivially portable to React DOM | Engineering time | Adapt concepts, not code -- DOM components are new implementations inspired by TUI |
| WebView rendering differences across OS | Visual inconsistencies | Pin WebView version via Tauri config; use CSS variables not system fonts |
| User expects Claude-level intelligence from local models | Disappointment | Clear model-quality messaging; OpenRouter fallback for cloud models |

---

## Out of Scope (Phase 1)

- Plugin marketplace
- Voice input (Whisper)
- Screenshot/file attachment drag-and-drop
- Team collaboration features
- Auto-update mechanism
- Linux/Windows builds
