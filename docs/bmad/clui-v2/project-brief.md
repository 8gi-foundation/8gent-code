# CLUI v2 — Desktop Agent Experience

**Author:** Business Analyst (BMAD)
**Date:** 2026-03-18
**Version:** 1.0
**Supersedes:** `docs/bmad/phase1-clui/project-brief.md` (CLUI v1 — scaffold)

---

## Problem Statement

CLUI v1 shipped a working desktop overlay: Alt+Space toggle, multi-tab sessions, streaming chat via Ollama, basic permission stubs. But it is a **chat window**, not an **agent experience**. The 8gent monorepo contains 39 packages — voice input, proactive planning with kanban boards, evidence collection, memory, tools, skills, kernel fine-tuning, self-autonomy — yet none of this is surfaced in the desktop client. A user opening CLUI today sees a text input and a message list. They have no idea the agent can plan ahead, collect proof, transcribe speech, or manage tool permissions.

The core failure: **capabilities that are invisible are capabilities that don't exist** from the user's perspective. Eight (the kernel) is powerful. CLUI (the client) doesn't show it.

Specific gaps:

1. **No transcription playback.** `packages/voice` has a full VoiceEngine (local Whisper + cloud fallback, VAD, model management) but CLUI has zero audio UI — no record button, no waveform, no transcript history.
2. **No tool approval UX.** `permissions.rs` defines a PermissionServer with auto-approve rules and pending request tracking, but `respond_to_permission` in `lib.rs` is a stub — the frontend never renders a permission dialog.
3. **No evidence panel.** `packages/validation` collects file_exists, diff, test_result, git_commit, command_output evidence with verification hashes — but the user never sees any of it.
4. **No plan visibility.** `packages/planning` maintains a kanban board (backlog/ready/inProgress/done) with proactive step prediction, momentum tracking, and plan injection from agent text — but there is no kanban view, no step progress, no momentum indicator.
5. **No settings surface.** Model selection, provider config, auto-approve rules, voice model, VAD toggle, theme — all hardcoded or absent.
6. **No proactive notifications.** The agent can predict next steps (`ProactivePlanner.getNextRecommendedStep()`) but never surfaces suggestions to the user.
7. **Bridge is thin.** `clui-bridge.ts` talks directly to Ollama's `/api/chat` with a flat message history. It doesn't route through `packages/eight`'s full agent loop (tools, planning, evidence, memory).

---

## Vision

CLUI v2 transforms the desktop overlay from a chat wrapper into a **rich agent cockpit**. The user sees what Eight is doing, what it plans to do next, what proof it collected, and what decisions it needs from them — all without leaving their editor.

The architecture remains: **Eight is the kernel, CLUI is the client.** CLUI v2 does not duplicate engine logic. It consumes richer NDJSON events from a properly wired bridge that routes through `packages/eight`'s full agent loop, and renders those events as first-class UI.

Key principles:
- **Proactive over reactive.** Surface predictions, suggestions, and status without being asked.
- **Evidence-first trust.** Every completed action shows proof. Users trust agents that show their work.
- **One-keystroke access to everything.** Alt+Space for the overlay, Cmd+K for command palette, hotkeys for every panel.
- **Local-first, cloud-optional.** Voice transcription via Whisper locally, cloud fallback. LLMs via Ollama, OpenRouter fallback.

---

## Target Users

### Primary: Solo Developers & Power Users
- Already use CLUI v1 or the TUI. Want to see what the agent is actually doing beneath the chat surface.
- Run local LLMs. Value privacy, zero cost, low latency.
- Keyboard-driven. Want hotkeys, not menus.

### Secondary: AI Tooling Evaluators & Early Adopters
- Comparing 8gent against Claude Code, Cursor, Windsurf, Copilot Workspace.
- Need to see planning, evidence, tool use — the features that differentiate 8gent.
- Will share screenshots/demos. Rich UI matters for virality.

### Tertiary: Small Teams (Future)
- Share agent configurations. Review tool audit logs. Use CLUI as the team's agent dashboard.
- Blocked until `packages/auth` and `packages/control-plane` are production-ready.

---

## Key Features (MoSCoW)

### Must Have (P0)

| # | Feature | Package Dependency | Description |
|---|---------|-------------------|-------------|
| 1 | **Full agent bridge** | `packages/eight` | Replace `clui-bridge.ts` direct-Ollama call with the full Eight agent loop. NDJSON events must include tool_call, tool_result, plan_update, evidence, memory_write, thinking — not just text tokens. |
| 2 | **Tool approval dialog** | `packages/permissions`, `permissions.rs` | When the agent requests a destructive tool (write_file, exec, git push), render a modal with tool name, input preview, session context. Approve/Deny/Always-Approve buttons. Wire to `respond_to_permission` IPC command. |
| 3 | **Evidence panel** | `packages/validation` | Collapsible side panel showing collected evidence per step: file_exists checks, diffs, test results, git commits. Each item shows verified/failed badge with hash. Surfaces `formatEvidence()` and `summarizeEvidence()` output. |
| 4 | **Plan kanban view** | `packages/planning` | Render `KanbanBoard` (backlog, ready, inProgress, done) as a compact horizontal kanban strip or expandable panel. Show step descriptions, confidence badges, category icons. Update in real-time as `ProactivePlanner` emits predictions. |
| 5 | **Voice input** | `packages/voice` | Record button (or Cmd+Shift+V hotkey). Visual waveform/level indicator during recording. Transcription status (recording -> transcribing -> done). Transcript inserted into chat input. Dependency check on first use (sox, whisper binary). |
| 6 | **Settings panel** | All packages | Accessible via gear icon or Cmd+, hotkey. Sections: Model (provider, model name, temperature), Voice (mode, model size, VAD toggle), Permissions (auto-approve rules editor), Theme (dark/light toggle), About (version, packages loaded). |

### Should Have (P1)

| # | Feature | Description |
|---|---------|-------------|
| 7 | **Command palette** | Cmd+K overlay. Fuzzy search over: slash commands, recent sessions, available tools, settings. Inspired by VS Code / Raycast. |
| 8 | **Proactive suggestions bar** | Thin bar below the input showing the agent's top 2-3 predicted next steps from `ProactivePlanner.getReadySteps()`. Click to execute. Fades when empty. |
| 9 | **Transcript history** | Scrollable list of voice transcriptions with timestamps. Tap to re-insert into input. Persisted per session. |
| 10 | **Momentum indicator** | Compact display showing steps/minute, streak count, session duration — from `ProactivePlanner.getMomentum()`. Gamifies the agent interaction. |
| 11 | **Multi-model switcher** | Dropdown in header to switch model mid-session. Calls to `packages/providers` for available model list. |
| 12 | **Session persistence** | Restore sessions across CLUI restarts. Serialize message history + plan state to `~/.8gent/sessions/`. |

### Could Have (P2)

| # | Feature | Description |
|---|---------|-------------|
| 13 | **Recording management** | Browse, playback, and delete saved voice recordings. Tag recordings with session context. |
| 14 | **Knowledge panel** | Surface `packages/memory` contents — show what the agent remembers about the current project. Edit/delete memory entries. |
| 15 | **Tool usage analytics** | Dashboard showing which tools were used, approval rates, evidence success rates. Data from `packages/reporting`. |
| 16 | **Notification toasts** | System-level notifications (macOS Notification Center) for long-running tasks completing, permission requests while CLUI is hidden. |
| 17 | **Drag-and-drop file attachment** | Drop files/screenshots onto CLUI to attach as context for the next message. |
| 18 | **Split pane diff viewer** | When evidence includes a diff, render it in a split-pane view with syntax highlighting. |

### Won't Have (This Version)

| # | Feature | Reason |
|---|---------|--------|
| 19 | Plugin marketplace | Requires `packages/registry` maturity and distribution infrastructure. |
| 20 | Team collaboration / shared sessions | Requires `packages/auth` + `packages/control-plane` production readiness. |
| 21 | Real-time voice conversation | Requires streaming STT + TTS loop, not just push-to-talk transcription. |
| 22 | Linux/Windows builds | CLUI v2 targets macOS. Cross-platform is a separate phase. |
| 23 | Auto-update mechanism | Ship manual downloads first. Auto-update adds Tauri updater complexity. |
| 24 | MCP server browser | `packages/mcp` integration is a separate feature track. |

---

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| **Agent bridge event coverage** | 100% of Eight event types forwarded to CLUI | Audit NDJSON schema against UI handlers |
| **Tool approval latency** | < 300ms from tool_call event to dialog visible | Instrumented in permission IPC round-trip |
| **Evidence panel engagement** | 60%+ of sessions where evidence is generated, user expands the panel | Analytics event on panel toggle |
| **Voice input adoption** | 15%+ of sessions include at least one voice transcription | Count sessions with voice events |
| **Plan visibility** | Kanban renders within 100ms of plan_update event | Performance instrumentation |
| **Settings completion** | All 5 settings sections functional | Manual QA checklist |
| **Overlay toggle latency** | < 200ms (maintained from v1) | Rust hotkey handler instrumentation |
| **Session restore success** | 95%+ of persisted sessions restore correctly | Automated test on app launch |

---

## Constraints & Dependencies

### Technical Constraints

1. **Bridge must route through Eight.** The `clui-bridge.ts` currently bypasses the full agent loop. v2 requires wiring through `packages/eight/index.ts` (or a new CLUI-specific entry point) so that planning, evidence, memory, and tools are active — not just chat completion.
2. **NDJSON event schema expansion.** The bridge currently emits `text`, `thinking`, `assistant_message`, `error`, `session_start`, `session_end`. Must add: `tool_call`, `tool_result`, `plan_update`, `evidence`, `memory_write`, `permission_request`, `voice_transcript`, `proactive_suggestion`.
3. **Tauri 2.0 webview limitations.** No Web Audio API access in Tauri webview — voice recording must happen in Rust or via the Bun subprocess, not in the browser context.
4. **Single-file App.tsx.** The current `App.tsx` is ~1500 lines in a single file. v2 must decompose into a proper component architecture (matching the TUI's `components/primitives/` pattern) before adding new panels.
5. **Bun runtime for subprocess.** Agent subprocess must be Bun. No Node.js fallback.
6. **No Electron.** Tauri 2.0 only.

### Package Dependencies

| Feature | Depends On |
|---------|-----------|
| Full bridge | `packages/eight`, `packages/providers`, `packages/tools`, `packages/memory` |
| Tool approval | `packages/permissions`, `permissions.rs` (Rust) |
| Evidence panel | `packages/validation` (`EvidenceCollector`, `formatEvidence`, `summarizeEvidence`) |
| Plan kanban | `packages/planning` (`ProactivePlanner`, `KanbanBoard`) |
| Voice input | `packages/voice` (`VoiceEngine`, `WhisperModelManager`, `VoiceActivityDetector`) |
| Settings | `packages/providers` (model list), `packages/voice` (voice config), `permissions.rs` (auto-approve rules) |
| Proactive suggestions | `packages/planning` (`getReadySteps`, `getNextRecommendedStep`) |
| Momentum | `packages/planning` (`getMomentum`) |
| Knowledge panel | `packages/memory` |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Bridge rewrite scope creep.** Wiring the full Eight loop into the CLUI bridge touches many packages and may surface integration bugs across tools, providers, and memory. | High | High | Define a minimal NDJSON event contract first. Bridge emits events; CLUI consumes them. Test bridge independently via CLI before Tauri integration. |
| **Voice recording in Tauri webview.** Web Audio API may not work in Tauri's WKWebView. Microphone permissions may require entitlements. | Medium | High | Route recording through `packages/voice` in the Bun subprocess (already implemented). Tauri sends start/stop commands over IPC; audio never touches the webview. |
| **App.tsx decomposition breaks existing features.** Splitting the monolithic component risks regressions in the working chat flow. | Medium | Medium | Write snapshot tests for current behavior before refactoring. Decompose incrementally: extract one component at a time. |
| **Kanban real-time updates cause render thrashing.** ProactivePlanner predicts 10+ steps per turn; naive rendering causes jank. | Medium | Medium | Debounce plan_update events. Batch state updates. Use React.memo on step cards. |
| **Voice model download UX.** First-time voice users must download a Whisper model (75MB-1.5GB). Poor progress UX causes abandonment. | Medium | Low | `WhisperModelManager` already emits download-progress events. Render a progress bar with size estimate. Allow background download. |
| **Permission server is still a stub.** `permissions.rs` holds response logic but has no real HTTP server — the oneshot channel pattern is commented out. | High | High | Implement the permission server properly in Rust (axum on localhost) before building the frontend dialog. Alternative: move permission approval to pure Tauri IPC commands without HTTP. |
| **Local LLM quality disappoints.** Users expect Claude/GPT-level planning from a 7B local model. Evidence and plans may be low quality. | High | Medium | Clear model-quality messaging in UI. Show which model is running. Offer easy OpenRouter fallback switch. Frame local models as "fast + private" not "best quality." |

---

## Out of Scope

- **Rewriting the Eight kernel.** CLUI v2 is a client. It consumes events. It does not modify `packages/eight`'s core agent loop, tool execution, or model routing.
- **New tool implementations.** If a tool doesn't exist in `packages/tools` or `packages/toolshed`, CLUI v2 doesn't add it.
- **Mobile/tablet builds.** Tauri 2.0 supports mobile but CLUI v2 targets macOS desktop only.
- **Authentication / multi-user.** `packages/auth` is not production-ready. Single-user local agent only.
- **Billing / usage metering.** No cost tracking for OpenRouter calls in this version.
- **Custom themes beyond dark/light.** Two themes. No theme editor.
- **Internationalization.** English only. `packages/i18n` integration is future work.
- **Kernel fine-tuning UI.** `packages/kernel` (RL training proxy) runs headless. No training dashboard in CLUI v2.

---

## Appendix: Current State Inventory

### What CLUI v1 Has (Working)

- Alt+Space global shortcut toggle (Rust, `tauri-plugin-global-shortcut`)
- System tray with Show/Hide, New Session, Quit
- Multi-tab session management (create, switch, close)
- Streaming chat via direct Ollama `/api/chat` call
- Dark/light theme with extended design tokens
- Agent mode bar (Autonomous/Supervised/Passive display)
- Shortcut bar UI (Cmd+N, Cmd+W, Cmd+T, Cmd+L, Cmd+K stubs)
- Message rendering with user/assistant/system/tool_call/error types
- Slash commands: `/model`, `/clear`, `/theme`, `/help`
- AgentCard, ToolCallRow, MemoryRow, EvidenceSummary components (rendered but fed mock/empty data)

### What Exists in Packages (Not Surfaced)

| Package | Key Exports | CLUI v2 Surface |
|---------|-------------|-----------------|
| `packages/voice` | `VoiceEngine`, `MicRecorder`, `WhisperModelManager`, `VoiceActivityDetector`, `transcribeLocal`, `transcribeCloud` | Voice input panel |
| `packages/planning` | `ProactivePlanner`, `KanbanBoard`, `ProactiveStep`, `getMomentum` | Plan kanban, suggestions bar, momentum indicator |
| `packages/validation` | `EvidenceCollector`, `formatEvidence`, `summarizeEvidence`, `isEvidenceSufficient` | Evidence panel |
| `packages/permissions` | Permission types, rule engine | Tool approval dialog (paired with `permissions.rs`) |
| `packages/memory` | Memory store | Knowledge panel (P2) |
| `packages/tools` | Tool registry | Tool list in settings |
| `packages/providers` | Model providers (Ollama, OpenRouter, LM Studio) | Model switcher, settings |
| `packages/personality` | Agent personality config | About section, agent tone settings |
| `packages/reporting` | Session reports | Tool analytics (P2) |
