# 8gent CLUI -- Epics & Stories

**Author:** Architect (BMAD Phase 1)
**Date:** 2026-03-16
**Version:** 1.0

---

## Epic 1: Tauri Shell (Foundation)

The native desktop shell that provides window management, global hotkey, system tray, and the React frontend scaffold.

### Story 1.1: Initialize Tauri 2.0 Project

**As a** developer,
**I want** a working Tauri 2.0 project scaffold at `apps/clui/`,
**so that** I can build and run the desktop app from the monorepo.

**Acceptance Criteria:**
- `apps/clui/` exists with `Cargo.toml`, `tauri.conf.json`, `package.json`, `vite.config.ts`
- `bun install` from monorepo root resolves all CLUI dependencies
- `bun run tauri dev` from `apps/clui/` launches a window with "Hello 8gent CLUI"
- Tauri 2.0 stable (not alpha/beta)

**Estimate:** 2 points

### Story 1.2: Alt+Space Global Hotkey Toggle

**As a** developer,
**I want** to press Alt+Space from any application to show/hide the CLUI overlay,
**so that** I can access the agent without switching windows.

**Acceptance Criteria:**
- Alt+Space toggles window visibility (show/hide)
- When hidden, the window is removed from Alt+Tab / Mission Control
- When shown, the window appears at its last position and size
- Hotkey works when the app is not focused (global shortcut)
- Hotkey is configurable in settings (stored in `~/.8gent/clui/config.json`)

**Estimate:** 3 points

### Story 1.3: Transparent Floating Overlay Window

**As a** developer,
**I want** the CLUI window to be a frameless, semi-transparent overlay that floats above other windows,
**so that** it feels like a native OS panel rather than a separate application.

**Acceptance Criteria:**
- Window has no native title bar (custom title bar in React)
- Window is always-on-top when visible
- Window has configurable opacity (default: 95%)
- Window is resizable by dragging edges
- Window position and size persist across restarts
- Rounded corners on macOS

**Estimate:** 3 points

### Story 1.4: System Tray with Session Indicators

**As a** developer,
**I want** a system tray icon that shows active session count and provides quick actions,
**so that** I can see agent status at a glance even when the overlay is hidden.

**Acceptance Criteria:**
- Tray icon appears on app launch
- Icon badge shows number of active agent sessions
- Right-click menu: "Show/Hide" (Alt+Space), "New Session", "Quit"
- Left-click toggles overlay visibility
- Icon color changes when any agent is actively processing (animated or color shift)

**Estimate:** 2 points

### Story 1.5: React Frontend Scaffold with Tailwind + Design Tokens

**As a** developer,
**I want** a React 19 frontend with Tailwind CSS 4 configured and 8gent design tokens mapped to CSS custom properties,
**so that** all CLUI components use the design system from day one.

**Acceptance Criteria:**
- React 19 renders in Tauri webview via Vite
- Tailwind CSS 4 configured with custom theme extending design tokens
- `tokens.css` defines all CSS custom properties matching TUI tokens
- Dark theme is default; light theme toggle placeholder exists
- No hardcoded colors in any component (all via CSS vars or Tailwind classes)

**Estimate:** 2 points

---

## Epic 2: Agent Sessions (Core)

Spawning, communicating with, and managing 8gent engine subprocesses.

### Story 2.1: Spawn 8gent Subprocess per Tab

**As a** developer,
**I want** each session tab to spawn an independent `bun run packages/eight/index.ts` process,
**so that** sessions are isolated and can run different tasks concurrently.

**Acceptance Criteria:**
- Clicking "+" in tab bar spawns a new Bun child process
- Process receives `cwd`, `model`, and `session_id` via environment variables
- Process stdout is captured line-by-line by Rust backend
- Process is killed (SIGTERM, then SIGKILL after 5s) when tab is closed
- Crash detection: if process exits unexpectedly, tab shows error state with "Restart" button

**Estimate:** 5 points

### Story 2.2: NDJSON Event Stream Parsing

**As a** developer,
**I want** the Rust backend to parse NDJSON events from each agent subprocess and emit them as Tauri events,
**so that** the React frontend receives structured, typed events in real-time.

**Acceptance Criteria:**
- Rust reads stdout line-by-line (buffered)
- Each line is parsed as JSON with serde
- Events are typed: `message`, `tool_call`, `tool_result`, `thinking`, `status`, `done`, `error`
- Malformed lines are logged and skipped (no crash)
- Events include `session_id` so frontend can route to correct tab
- Latency from agent stdout to React event: < 16ms

**Estimate:** 3 points

### Story 2.3: Multi-Tab Session Management with Zustand

**As a** developer,
**I want** a Zustand store that tracks all open sessions, their messages, and their status,
**so that** the React UI can render any tab's content instantly.

**Acceptance Criteria:**
- Store holds `Map<sessionId, SessionState>`
- `SessionState` includes: messages, status, model, thinking state, tool calls
- Actions: `createSession`, `closeSession`, `switchTab`, `appendMessage`, `updateStatus`
- Active tab ID tracked separately
- Switching tabs is instant (no re-fetch, no re-render of other tabs)
- Maximum 10 concurrent sessions (configurable)

**Estimate:** 3 points

### Story 2.4: Session Persistence and Resume

**As a** developer,
**I want** sessions to be saved to disk and resumable,
**so that** I don't lose context when I close CLUI or restart my machine.

**Acceptance Criteria:**
- Sessions auto-save to `~/.8gent/clui/sessions/{id}.json` on every message
- On launch, CLUI shows list of recent sessions in a "Resume" tab
- Resuming a session restores message history in the UI
- Resumed sessions spawn a fresh agent subprocess with session context
- Sessions older than 7 days are archived (moved to `~/.8gent/clui/archive/`)

**Estimate:** 5 points

### Story 2.5: Model Selection per Tab

**As a** developer,
**I want** to choose which model powers each session tab,
**so that** I can use a fast local model for simple tasks and a cloud model for complex ones.

**Acceptance Criteria:**
- Dropdown in tab header or status bar shows available models
- Models sourced from: Ollama (`ollama list`), OpenRouter API, LM Studio API
- Selected model is passed to agent subprocess via env var
- Model can be changed mid-session (spawns new subprocess, preserves history)
- Default model configurable in `~/.8gent/clui/config.json`

**Estimate:** 3 points

---

## Epic 3: UI Components (Adapted from TUI)

React DOM components inspired by the existing Ink TUI, reimplemented for the web.

### Story 3.1: Message List with Streaming

**As a** developer,
**I want** a chat-style message list that shows user and agent messages with real-time streaming,
**so that** I can follow the conversation as it happens.

**Acceptance Criteria:**
- User messages: right-aligned, branded border (yellow in TUI -> warning color)
- Agent messages: left-aligned, branded border (cyan in TUI -> accent color)
- Tool call results: compact inline cards with success/failure indicators
- System messages: centered, muted divider style
- New agent messages stream token-by-token
- Auto-scroll to bottom on new messages
- Code blocks render with syntax highlighting and copy button

**Estimate:** 5 points

### Story 3.2: ThinkingView

**As a** developer,
**I want** to see an animated visualization while the agent is processing,
**so that** I know the agent is working and what stage it's in.

**Acceptance Criteria:**
- Animated dot grid (CSS animation, not JS interval)
- Rotating status text: "Planning approach...", "Analyzing context...", etc.
- Real-time counters: steps completed, tools called, elapsed time
- Processing stage label: PLANNING / TOOLSHED / EXECUTING
- Smooth transitions between stages
- Respects `prefers-reduced-motion`

**Estimate:** 3 points

### Story 3.3: Evidence Badges Panel

**As a** developer,
**I want** to see evidence collected by the agent with verification badges,
**so that** I can trust the agent's claims.

**Acceptance Criteria:**
- Collapsible side panel or inline section
- Each evidence item: type badge, description, verified/failed icon
- Expandable details: path, command, exit code, duration, data preview
- Confidence meter (progress bar with percentage)
- Summary counts by type at bottom
- Keyboard navigable (arrow keys + Enter to expand)

**Estimate:** 5 points

### Story 3.4: Plan Kanban Board

**As a** developer,
**I want** a kanban board showing the agent's planned steps across 4 columns,
**so that** I can see the full execution plan at a glance.

**Acceptance Criteria:**
- 4 columns: Backlog, Ready, In Progress, Done
- Each card: category icon, description, priority badge, confidence %
- Cards move between columns as agent progresses
- Column headers show item count
- Compact mode for smaller windows
- Toggleable via `/kanban` slash command or Cmd+K shortcut

**Estimate:** 5 points

### Story 3.5: Command Input with Slash Commands

**As a** developer,
**I want** a text input that supports slash commands with autocomplete,
**so that** I can quickly access features without leaving the keyboard.

**Acceptance Criteria:**
- Slash command autocomplete dropdown when typing `/`
- All TUI slash commands supported: `/help`, `/kanban`, `/predict`, `/avenues`, `/model`, etc.
- Ghost text suggestions (Tab to accept)
- Animated prompt indicator (color cycling)
- Input remains visible during agent processing (can queue follow-up)
- Cmd+Enter for multi-line input (future)

**Estimate:** 3 points

### Story 3.6: Status Bar

**As a** developer,
**I want** a persistent status bar showing model, agents, permissions, tokens, git branch, and time,
**so that** I always have context about the current session.

**Acceptance Criteria:**
- Left: model name + agent count
- Center: plan status (animated verb) + permission mode badge
- Right: token savings %, git branch, elapsed time
- Compact mode for narrow windows
- Click model name to open model selector
- Click permission badge to toggle permission mode

**Estimate:** 3 points

---

## Epic 4: Safety & Permissions (Human-in-the-Loop)

The permission system that ensures the agent cannot silently modify the developer's codebase.

### Story 4.1: Permission Server

**As a** developer,
**I want** a localhost HTTP server that intercepts agent tool calls and waits for approval,
**so that** no tool executes without my explicit consent.

**Acceptance Criteria:**
- Rust spawns HTTP server on ephemeral port at CLUI startup
- Port passed to agent subprocess via `PERMISSION_SERVER_PORT` env var
- Agent sends POST `/approve` with tool call details before executing
- Server holds request open until approval/denial received
- Timeout after 60s defaults to deny
- Server stops when CLUI exits

**Estimate:** 5 points

### Story 4.2: Approval/Deny UI

**As a** developer,
**I want** a modal dialog showing tool name, inputs, and approve/deny buttons,
**so that** I can make an informed decision about each tool call.

**Acceptance Criteria:**
- Modal appears over the chat when tool call needs approval
- Shows: tool name, full input parameters (collapsible JSON), risk level
- Buttons: "Approve" (green), "Deny" (red), "Approve All of This Type" (yellow)
- Keyboard shortcuts: Enter = approve, Escape = deny, Shift+Enter = approve all
- Modal stacks if multiple approvals are pending
- Approval/denial sent to Rust backend via Tauri command

**Estimate:** 3 points

### Story 4.3: Auto-Approve Rules

**As a** developer,
**I want** to configure which tool types are auto-approved,
**so that** I reduce friction for safe read-only operations.

**Acceptance Criteria:**
- Rules stored in `~/.8gent/clui/permissions.json`
- Default: all tools require approval
- Per-tool-type rules: `always_approve`, `always_deny`, `ask`
- Per-path rules: auto-approve reads in project dir, deny writes outside project
- Rules editable in Settings screen and via `/permissions` slash command
- Rules apply before the approval UI is shown

**Estimate:** 3 points

### Story 4.4: Audit Log

**As a** developer,
**I want** a complete log of every tool execution with timestamps and outcomes,
**so that** I can trace what the agent did in any session.

**Acceptance Criteria:**
- Every tool call logged: timestamp, tool name, inputs, approval decision, output, duration
- Audit log per session, saved alongside session file
- Viewable in CLUI via `/audit` slash command
- Filterable by tool type, time range, approval status
- Exportable as JSON or Markdown

**Estimate:** 3 points

---

## Epic 5: Polish

### Story 5.1: Dark/Light Theme with System Follow

**As a** developer,
**I want** dark and light themes that follow my system preference,
**so that** the overlay matches my environment.

**Acceptance Criteria:**
- Dark theme (default): dark background, light text
- Light theme: light background, dark text
- System follow: respects `prefers-color-scheme` media query
- Manual override in settings
- All colors defined as CSS custom properties -- theme swap is one class change
- Transitions between themes are smooth (200ms)

**Estimate:** 2 points

### Story 5.2: Keyboard Shortcuts Panel

**As a** developer,
**I want** a visual reference of all keyboard shortcuts,
**so that** I can learn and use them efficiently.

**Acceptance Criteria:**
- Triggered by `Cmd+/` or `/shortcuts` slash command
- Overlay panel listing all shortcuts grouped by category
- Categories: Navigation, Sessions, Panels, Input, System
- Dismissible with Escape
- Shortcuts match actual key bindings (not hardcoded text)

**Estimate:** 2 points

### Story 5.3: Settings Screen

**As a** developer,
**I want** a settings screen for model config, hotkey, theme, and permissions,
**so that** I can customize CLUI to my preferences.

**Acceptance Criteria:**
- Accessible via gear icon in header or `/settings` slash command
- Sections: General, Models, Permissions, Appearance, Keyboard
- Changes save immediately to `~/.8gent/clui/config.json`
- Model section: add/remove Ollama models, configure OpenRouter API key
- Permission section: edit auto-approve rules
- Appearance section: theme, opacity, window size defaults

**Estimate:** 5 points

### Story 5.4: Auto-Update Mechanism

**As a** developer,
**I want** CLUI to check for updates and prompt me to install them,
**so that** I always have the latest features and fixes.

**Acceptance Criteria:**
- On launch, check GitHub Releases API for newer version
- If update available, show non-intrusive notification in status bar
- Click notification to open release notes and "Update Now" button
- Update downloads new binary and restarts (Tauri updater plugin)
- Check frequency: once per day (configurable)
- Can be disabled in settings

**Estimate:** 3 points

---

## Dependency Graph

```
Epic 1 (Tauri Shell)
  |
  +---> Epic 2 (Agent Sessions) -- depends on 1.1, 1.5
  |       |
  |       +---> Epic 3 (UI Components) -- depends on 2.2, 2.3
  |       |
  |       +---> Epic 4 (Safety) -- depends on 2.1, 2.2
  |
  +---> Epic 5 (Polish) -- depends on 1.5, 3.x
```

---

## Sprint Plan (Suggested)

| Sprint | Duration | Epics | Goal |
|--------|----------|-------|------|
| Sprint 1 | 2 weeks | Epic 1 (all stories) | Tauri shell running with React frontend |
| Sprint 2 | 2 weeks | Epic 2 (2.1, 2.2, 2.3) | Agent spawning and event streaming |
| Sprint 3 | 2 weeks | Epic 3 (3.1, 3.5, 3.6) | Core chat UI working end-to-end |
| Sprint 4 | 2 weeks | Epic 4 (4.1, 4.2, 4.3) | Permission system functional |
| Sprint 5 | 2 weeks | Epic 3 (3.2, 3.3, 3.4) + Epic 2 (2.4, 2.5) | Rich UI panels + persistence |
| Sprint 6 | 1 week | Epic 5 (5.1, 5.2) + Epic 4 (4.4) | Polish + audit log |

**Total estimated timeline:** 11 weeks to MVP with full feature set.
