# 8gent CLUI -- Product Requirements Document

**Author:** Product Manager (BMAD Phase 1)
**Date:** 2026-03-16
**Version:** 1.0

---

## User Stories

### Developer Workflow

- **US-001:** As a developer, I want to press Alt+Space from any application to toggle the 8gent overlay so I never leave my editor to interact with the agent.
- **US-002:** As a developer, I want to open multiple session tabs so I can run parallel agents on different tasks or repos.
- **US-003:** As a developer, I want to see real-time streaming of the agent's response so I know it is working and can intervene early.
- **US-004:** As a developer, I want to choose which model powers each session (Ollama local, OpenRouter cloud, LM Studio) so I can balance quality, speed, and cost.
- **US-005:** As a developer, I want to resume a previous session so I don't lose context when I close the overlay.

### Safety & Control

- **US-006:** As a developer, I want to approve or deny each tool call before it executes so the agent cannot silently modify my codebase.
- **US-007:** As a developer, I want to configure auto-approve rules per tool type (e.g., always allow `read_file`, always ask for `write_file`) so I reduce friction for safe operations.
- **US-008:** As a developer, I want to see a full audit log of every tool the agent executed, with timestamps and outcomes, so I can trace what happened.

### Visibility & Understanding

- **US-009:** As a developer, I want to see the agent's thinking process (ThinkingView) so I understand its reasoning before it acts.
- **US-010:** As a developer, I want evidence badges showing verification status so I can trust the agent's claims.
- **US-011:** As a developer, I want a kanban board of the agent's planned steps so I can see the full execution plan at a glance.
- **US-012:** As a developer, I want a status bar showing model name, token usage, elapsed time, and git branch so I have persistent context.

### Customization

- **US-013:** As a developer, I want to switch between dark and light themes (or follow system preference) so the overlay matches my environment.
- **US-014:** As a developer, I want to use slash commands (same as TUI) so my muscle memory transfers.
- **US-015:** As a developer, I want keyboard shortcuts for common actions (new tab, close tab, switch tab, toggle panels) so I stay in flow.

---

## Feature Prioritization

### P0 -- Must Have (MVP)

| Feature | Description | Stories |
|---------|-------------|---------|
| **Floating overlay window** | Transparent, always-on-top, frameless Tauri window | US-001 |
| **Alt+Space global hotkey** | Toggle overlay visibility from any app | US-001 |
| **Multi-session tabs** | Tab bar with new/close/switch tab actions | US-002 |
| **Agent subprocess management** | Spawn `bun run packages/eight/index.ts` per tab | US-002 |
| **NDJSON event stream parsing** | Parse tool calls, messages, thinking tokens from stdout | US-003 |
| **Message list (streaming)** | Chat-style message display with real-time token streaming | US-003 |
| **Command input** | Text input with slash command support | US-014 |
| **System tray** | Tray icon with session count indicator | US-001 |
| **Basic status bar** | Model name, token count, elapsed time | US-012 |

### P1 -- Should Have (Post-MVP)

| Feature | Description | Stories |
|---------|-------------|---------|
| **Permission approval UI** | Modal dialog for tool-call approval/denial | US-006 |
| **Auto-approve rules** | Per-tool-type configuration for automatic approval | US-007 |
| **Evidence badges panel** | Adapted from TUI evidence-panel.tsx | US-010 |
| **ThinkingView** | Adapted from TUI ThinkingView.tsx -- animated status while agent processes | US-009 |
| **Plan kanban board** | Adapted from TUI plan-kanban.tsx -- 4-column step tracker | US-011 |
| **Model selection per tab** | Dropdown to pick Ollama/OpenRouter/LM Studio model | US-004 |
| **Session persistence** | Save/resume sessions to disk | US-005 |
| **Audit log viewer** | Scrollable list of all tool executions with timestamps | US-008 |

### P2 -- Nice to Have (Future)

| Feature | Description | Stories |
|---------|-------------|---------|
| **Plugin marketplace** | Install community tools/skills from registry | -- |
| **Voice input (Whisper)** | Press-to-talk voice transcription | -- |
| **Screenshot attachment** | Drag-and-drop or paste screenshots into prompt | -- |
| **Dark/light/system theme** | Theme picker with CSS variable swap | US-013 |
| **Keyboard shortcuts panel** | Visual shortcut reference overlay | US-015 |
| **Settings screen** | Full configuration UI (model config, hotkey, theme, permissions) | -- |
| **Auto-update** | Check GitHub Releases and prompt for update | -- |
| **Linux/Windows builds** | Cross-platform CI/CD | -- |

---

## Non-Functional Requirements

### Performance

| Metric | Requirement |
|--------|-------------|
| Overlay toggle latency | < 200ms |
| Session spawn time | < 1s |
| NDJSON event processing latency | < 16ms (one frame at 60fps) |
| UI frame rate | 60fps during streaming |
| Memory (CLUI shell, no agents) | < 50 MB |
| Memory per agent session | < 30 MB (Bun subprocess) |

### Binary & Distribution

| Metric | Requirement |
|--------|-------------|
| macOS app bundle size | < 15 MB |
| Installation method | DMG + Homebrew cask (Phase 1), `brew install 8gent-clui` |
| Auto-start option | Launch at login via system tray preference |

### Security

| Requirement | Details |
|-------------|---------|
| No telemetry | Zero data leaves the machine unless user opts into OpenRouter |
| Permission server | Localhost-only HTTP, no network exposure |
| Subprocess isolation | Each agent tab runs in its own Bun process with its own cwd |
| No root access | CLUI never requires sudo/admin |

### Accessibility

| Requirement | Details |
|-------------|---------|
| Keyboard-only operation | Every action reachable via keyboard |
| Screen reader labels | ARIA labels on all interactive elements |
| Color contrast | All text meets WCAG AA on both dark and light backgrounds |
| Reduced motion | Respect `prefers-reduced-motion` for animations |

---

## Integration Points with Existing Packages

| Package | Integration |
|---------|------------|
| `packages/eight` | Spawned as Bun subprocess per session tab |
| `packages/specifications` | Session spec v2 for persistence format |
| `packages/toolshed` | Tool definitions exposed via NDJSON events (tool_call, tool_result) |
| `packages/skills` | Skill registry available through slash commands |
| `packages/providers` | Model/provider list for model selector dropdown |
| `packages/memory` | Session memory loaded automatically by eight subprocess |
| `packages/kernel` | MetaClaw pipeline runs inside eight subprocess (transparent to CLUI) |
| `apps/tui/src/theme/` | Design tokens adapted to CSS custom properties |
| `apps/tui/src/components/` | UI patterns adapted from Ink to React DOM (not imported, re-implemented) |

---

## Wireframes (Text)

```
+------------------------------------------------------------------+
| [Tab 1: main] [Tab 2: feature/auth] [+]                    [_][X] |
+------------------------------------------------------------------+
|                                                                    |
|  12:34 You                                                         |
|  +--------------------------------------------------------------+  |
|  | Fix the auth middleware to handle expired JWT tokens          |  |
|  +--------------------------------------------------------------+  |
|                                                                    |
|  * 8gent 12:34                                                    |
|  +--------------------------------------------------------------+  |
|  | I'll fix the auth middleware. Let me start by reading the     |  |
|  | current implementation...                                     |  |
|  +--------------------------------------------------------------+  |
|                                                                    |
|    > read_file src/middleware/auth.ts                [Approved]     |
|    > write_file src/middleware/auth.ts               [Pending]      |
|                                                                    |
+------------------------------------------------------------------+
| > Type a command or ask a question...               [Tab] suggest  |
+------------------------------------------------------------------+
| [qwen3.5] * 1/1 agents  [? Ask Mode]  v42% (1.2k)  main  0:34   |
+------------------------------------------------------------------+
```

---

## Open Questions

1. Should the overlay be resizable, or fixed to a preset size (e.g., 600x800)?
2. Should sessions auto-save on every message, or only on explicit save/close?
3. Should the permission server run as a shared singleton or one per session?
4. What is the IPC protocol between Tauri Rust backend and React frontend -- Tauri commands + events, or a local WebSocket?
