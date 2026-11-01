# 8gent CLUI -- Architecture Document

**Author:** Architect (BMAD Phase 1)
**Date:** 2026-03-16
**Version:** 1.0

---

## Decision: Tauri 2.0 over Electron

### Rationale

| Factor | Electron 33 | Tauri 2.0 | Winner |
|--------|------------|-----------|--------|
| Binary size | ~150 MB (bundles Chromium) | ~5-10 MB (uses OS webview) | Tauri |
| Memory baseline | ~80-120 MB | ~20-30 MB | Tauri |
| Backend language | Node.js (JavaScript) | Rust | Tauri (performance, safety) |
| Cross-platform | macOS, Linux, Windows | macOS, Linux, Windows, iOS, Android | Tauri |
| IPC | Electron IPC (JSON serialization) | Tauri Commands + Events (serde) | Tauri |
| Global hotkeys | electron-globalShortcut (works) | tauri-plugin-global-shortcut (works) | Tie |
| Webview | Chromium (consistent) | WKWebView/WebView2/WebKitGTK (varies) | Electron |
| Ecosystem maturity | Very mature | Mature (v2 stable) | Electron |

**Decision:** Tauri 2.0. The binary size and memory advantages align with 8gent's lightweight philosophy. The Rust backend provides a natural home for process management, hotkey handling, and the permission server. The webview inconsistency risk is mitigated by targeting macOS first (WKWebView is excellent) and using CSS custom properties rather than system-dependent styling.

---

## High-Level Architecture

```
+---------------------------------------------------+
|                  macOS / Linux / Windows            |
|                                                     |
|  +-----------------------------------------------+ |
|  |              Tauri 2.0 Shell                   | |
|  |  (Rust binary: window mgmt, hotkey, tray)      | |
|  |                                                 | |
|  |  +-------------------------------------------+ | |
|  |  |        React 19 Frontend (WebView)        | | |
|  |  |  Tailwind CSS 4 + Zustand 5 + Components  | | |
|  |  +-------------------------------------------+ | |
|  |                     |                           | |
|  |              Tauri IPC (Commands + Events)      | |
|  |                     |                           | |
|  |  +-------------------------------------------+ | |
|  |  |           Rust Backend                     | | |
|  |  |  +-------------+  +--------------------+  | | |
|  |  |  | RunManager  |  | PermissionServer   |  | | |
|  |  |  | (spawn Bun  |  | (localhost HTTP     |  | | |
|  |  |  |  per tab)   |  |  tool approval)    |  | | |
|  |  |  +------+------+  +--------------------+  | | |
|  |  +---------|----------------------------------+ | |
|  +------------|------------------------------------+ |
|               |                                      |
|     +---------v-----------+                          |
|     | Bun Subprocess      |  (one per session tab)   |
|     | packages/eight      |                          |
|     | NDJSON stdout --->  |                          |
|     +---------------------+                          |
+------------------------------------------------------+
```

---

## Directory Structure

```
apps/clui/
  package.json                  # Tauri + React + Tailwind + Zustand deps
  vite.config.ts                # Vite dev server for React frontend
  tsconfig.json                 # TypeScript config
  tailwind.config.ts            # Design tokens as CSS custom properties
  index.html                    # Vite entry point

  src/                          # React frontend
    App.tsx                     # Root component: tab bar + session panels
    main.tsx                    # React DOM entry point
    stores/
      session-store.ts          # Zustand: multi-tab session state
    components/
      MessageList.tsx           # Chat messages (adapted from TUI message-list.tsx)
      ThinkingView.tsx          # Processing animation (adapted from TUI ThinkingView.tsx)
      EvidencePanel.tsx         # Evidence badges (adapted from TUI evidence-panel.tsx)
      PlanKanban.tsx            # Kanban board (adapted from TUI plan-kanban.tsx)
      CommandInput.tsx          # Input with slash commands (adapted from TUI command-input.tsx)
      StatusBar.tsx             # Model/token/git status (adapted from TUI status-bar.tsx)
      PermissionDialog.tsx      # Tool approval modal
      TabBar.tsx                # Session tab strip
    styles/
      tokens.css                # CSS custom properties from design tokens

  src-tauri/                    # Rust backend
    Cargo.toml                  # Tauri 2.0 + dependencies
    tauri.conf.json             # Window config: transparent, overlay, always-on-top
    src/
      main.rs                   # App entry: window, hotkey, tray, IPC commands
      agent.rs                  # AgentSession: spawn/kill Bun, parse NDJSON
      permissions.rs            # PermissionServer: localhost HTTP for tool approval
```

---

## Key Design Decisions

### 1. One Bun Subprocess per Tab

Each session tab spawns an independent `bun run packages/eight/index.ts` process. Communication is via NDJSON over stdout. This provides:

- **Isolation:** A crashed agent does not take down other tabs.
- **Concurrency:** Multiple agents run truly in parallel.
- **Simplicity:** No in-process agent state to manage in Rust.

The Rust `RunManager` tracks PIDs, handles graceful shutdown (SIGTERM then SIGKILL after 5s), and restarts on crash if configured.

### 2. NDJSON Event Protocol

The 8gent engine outputs newline-delimited JSON events:

```jsonl
{"type":"message","role":"assistant","content":"I'll read the file...","timestamp":"..."}
{"type":"tool_call","name":"read_file","input":{"path":"src/auth.ts"},"id":"tc_001"}
{"type":"tool_result","id":"tc_001","output":"...file contents...","success":true}
{"type":"thinking","content":"The auth middleware needs...","phase":"planning"}
{"type":"status","stage":"executing","step":3,"total":5}
{"type":"done","summary":"Fixed auth middleware","tokens_used":1234}
```

The React frontend subscribes to Tauri events that the Rust backend emits after parsing each NDJSON line from stdout.

### 3. Design Token Mapping

TUI tokens (safe ANSI colors) map to CSS custom properties:

```
tokens.ts color.red    -->  --color-red: #ef4444
tokens.ts color.green  -->  --color-green: #22c55e
tokens.ts color.yellow -->  --color-yellow: #eab308
tokens.ts color.blue   -->  --color-blue: #3b82f6
tokens.ts color.magenta --> --color-magenta: #a855f7
tokens.ts color.cyan   -->  --color-cyan: #06b6d4

semantic.ts text.muted   --> --text-muted: color-mix(in srgb, var(--text-primary) 50%, transparent)
semantic.ts text.success --> --text-success: var(--color-green)
semantic.ts text.warning --> --text-warning: var(--color-yellow)
semantic.ts text.danger  --> --text-danger: var(--color-red)
semantic.ts text.accent  --> --text-accent: var(--color-cyan)
semantic.ts text.info    --> --text-info: var(--color-blue)
semantic.ts text.brand   --> --text-brand: var(--color-magenta)
```

Dark and light themes swap `--text-primary` and `--bg-primary`. No component ever uses a hardcoded color.

### 4. Permission Server

A localhost-only HTTP server (port auto-assigned, passed to agent via env var) intercepts tool calls:

1. Agent emits `{"type":"tool_call",...}` on stdout.
2. Rust backend parses it and checks auto-approve rules.
3. If not auto-approved, Rust emits a Tauri event to the frontend.
4. Frontend shows `PermissionDialog` with tool name, inputs, and approve/deny buttons.
5. User clicks approve/deny.
6. Frontend sends Tauri command back to Rust.
7. Rust responds to the agent's HTTP request with the decision.
8. Agent proceeds or aborts the tool call.

### 5. Component Adaptation Strategy

TUI components use Ink's `<Box>`, `<Text>`, `useInput()`. CLUI components use React DOM `<div>`, `<span>`, `onKeyDown`. The adaptation is conceptual, not mechanical:

| TUI Concept | CLUI Equivalent |
|-------------|----------------|
| `<Box flexDirection="column">` | `<div className="flex flex-col">` |
| `<Text color="cyan">` | `<span className="text-accent">` |
| `<Text dimColor>` | `<span className="text-muted">` |
| `<Text bold>` | `<span className="font-bold">` |
| `useInput()` | `useEffect` + `addEventListener('keydown')` |
| `<Box borderStyle="round" borderColor="cyan">` | `<div className="border border-accent rounded">` |
| Ink `<Spinner>` | CSS animation or Framer Motion |

### 6. Session Persistence

Sessions are saved to `~/.8gent/clui/sessions/{session-id}.json` using the `packages/specifications` session format (v2). On resume, CLUI replays the message history into the UI and spawns a new agent subprocess with the session context preloaded.

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Tauri | 2.0 |
| Backend | Rust | 1.75+ |
| Frontend framework | React | 19 |
| State management | Zustand | 5 |
| Styling | Tailwind CSS | 4 |
| Build tool | Vite | 6 |
| Animation | Framer Motion | 12 |
| Agent runtime | Bun | 1.1+ |
| Agent engine | packages/eight | (monorepo) |
| IPC | Tauri Commands + Events | (built-in) |

---

## Data Flow: User Sends a Message

```
1. User types in CommandInput, presses Enter
2. React dispatches Zustand action: sendMessage(tabId, text)
3. Zustand store calls Tauri command: send_to_agent(tabId, text)
4. Rust RunManager writes text + newline to agent subprocess stdin
5. Agent processes, emits NDJSON events on stdout
6. Rust reads stdout line-by-line, parses JSON
7. For each event, Rust emits Tauri event: agent_event(tabId, event)
8. React listens via useEffect + listen("agent_event")
9. Zustand store updates session state (messages, thinking, tool calls)
10. React re-renders MessageList, ThinkingView, StatusBar, etc.
```

---

## Security Model

- **No network listeners** except localhost permission server (ephemeral port).
- **No telemetry.** No data leaves the machine.
- **Subprocess sandboxing.** Each agent runs with the user's permissions in its own cwd. No privilege escalation.
- **CSP in webview.** Content Security Policy restricts the webview to localhost resources only.
- **Auto-approve rules** default to deny-all. Users must explicitly configure auto-approve for each tool type.
