# CLUI v2 Architecture Document

> **Eight = kernel. 8gent-code = client. CLUI = the rich desktop surface.**

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Date** | 2026-03-18 |
| **Owner** | James Spalding |
| **Stack** | Tauri 2.0 (Rust) + React 19 + Vite + Tailwind CSS 4 + Zustand |

---

## 1. System Context Diagram

```
                         +-------------------+
                         |     Human User    |
                         +--------+----------+
                                  |
                    keyboard / voice / mouse
                                  |
                         +--------v----------+
                         |   CLUI Desktop    |
                         |   (Tauri 2.0)     |
                         |                   |
                         |  React 19 WebView |
                         |  Rust Backend     |
                         +---+--------+------+
                             |        |
               Tauri IPC     |        |  Child process (Bun)
               (invoke /     |        |  stdio NDJSON
                emit)        |        |
                             |   +----v-----------+
                             |   |  Bridge.ts      |
                             |   |  (per session)   |
                             |   +----+------------+
                             |        |
                             |        | HTTP (streaming)
                             |        |
                        +----v--------v---------+
                        |      Ollama / LLM     |
                        |   localhost:11434      |
                        +-----------------------+
                                  |
                        (or OpenRouter / LM Studio
                         via provider config)

  +------------------------------------------------------------------+
  |                        Monorepo Packages                         |
  |                                                                  |
  |  @8gent/voice     @8gent/planning   @8gent/validation            |
  |  (Whisper STT)    (ProactivePlanner  (EvidenceCollector           |
  |                    AvenueTracker)     ValidationReporter)         |
  |                                                                  |
  |  @8gent/auth      @8gent/eight       @8gent/kernel               |
  |  (Clerk device    (agent engine)     (RL training                |
  |   flow, Keychain)                     proxy)                     |
  +------------------------------------------------------------------+
```

### Boundaries

| Boundary | Protocol | Trust |
|----------|----------|-------|
| User to CLUI | Native window, global shortcut (Alt+Space) | Full |
| React to Rust | Tauri IPC (invoke + event emit) | Sandboxed via Tauri capabilities |
| Rust to Bridge | Child process stdio (stdin/stdout NDJSON) | Subprocess per session |
| Bridge to Ollama | HTTP streaming (POST /api/chat) | Localhost-only |
| Agent to Permission Server | HTTP POST to localhost ephemeral port | Held until user approves |
| CLUI to Convex | Optional cloud sync (auth, preferences) | Authenticated only |

---

## 2. Component Architecture

### 2.1 Rust Backend (`apps/clui/src-tauri/src/`)

The Rust layer is thin by design. It manages process lifecycle, permissions, and IPC -- it does not contain business logic.

**`lib.rs`** -- Tauri application setup:
- Registers all IPC commands (`create_session`, `send_to_agent`, `close_session`, `list_sessions`, `respond_to_permission`)
- Initializes `AppState` with `AgentManager` and `PermissionServer` behind `Mutex`
- Sets up system tray (Show/Hide, New Session, Quit)
- Registers `tauri-plugin-global-shortcut` for Alt+Space toggle
- Registers `tauri-plugin-shell` for external link opens

**`agent.rs`** -- `AgentManager` subprocess orchestrator:
- `HashMap<String, AgentSession>` for concurrent sessions
- Each session spawns `bun run apps/clui/bridge.ts` with environment:
  - `EIGHT_SESSION_ID`, `EIGHT_MODEL`, `EIGHT_OUTPUT_FORMAT=ndjson`, `EIGHT_CLUI_MODE=true`, `EIGHT_REPO_ROOT`
- Dedicated reader thread per session parses NDJSON from stdout, emits `agent_event` to React via Tauri events
- Separate stderr reader thread forwards debug logs as `stderr` events
- Graceful shutdown: close stdin (EOF signal), then `SIGTERM`
- Path resolution: `EIGHT_REPO_ROOT` env > `CARGO_MANIFEST_DIR` ancestry > cwd walk > fallback
- Bun binary discovery: `~/.bun/bin/bun` > `/usr/local/bin/bun` > `/opt/homebrew/bin/bun` > `PATH`

**`permissions.rs`** -- `PermissionServer` for human-in-the-loop:
- Localhost HTTP server (planned: axum on ephemeral port, currently scaffold)
- Agent subprocess POSTs `{ tool, input, session_id }` before executing any tool
- Server emits Tauri event `permission_request` to frontend
- Frontend calls `respond_to_permission` IPC command
- Default auto-approve rules: `read_file`, `list_directory`, `search_*` are auto-approved
- Write/exec tools require explicit approval
- Pattern matching with glob-style `*` suffix

### 2.2 Bridge Layer (`apps/clui/bridge.ts`)

A standalone Bun script that avoids monorepo workspace resolution issues. One instance per session tab.

**Responsibilities:**
- Reads user prompts from stdin (line-delimited)
- Maintains conversation history (`system` + user/assistant turns)
- Streams responses from Ollama `/api/chat` with `stream: true`
- Emits token-by-token NDJSON events: `{ type: "text", content: "<token>" }`
- Filters `<think>` / `</think>` tokens from reasoning models (Qwen, DeepSeek)
- Lifecycle events: `session_start`, `ready`, `thinking`, `assistant_message`, `error`, `session_end`
- Loads system prompt from `packages/eight/prompts/system-prompt.ts` (falls back to inline default)

**NDJSON Event Protocol:**

| Event Type | Payload | When |
|------------|---------|------|
| `session_start` | `{ model, cwd, sessionId }` | Bridge boots |
| `ready` | `{ message }` | Ready for input |
| `thinking` | `{ content: "" }` | Before LLM call |
| `text` | `{ content: "<token>" }` | Each streaming token |
| `assistant_message` | `{ content: "<full>" }` | Stream complete |
| `error` | `{ message }` | Any failure |
| `session_end` | `{ reason }` | Process exiting |
| `stderr` | `{ content }` | Debug log from bridge |

There is also a secondary bridge at `packages/eight/clui-bridge.ts` with identical logic. The standalone `apps/clui/bridge.ts` is preferred at runtime to avoid workspace import issues.

### 2.3 React Frontend (`apps/clui/src/`)

**Entry:** `main.tsx` renders `<App />` into `#root`.

**App Shell (`App.tsx`):**
- Full-featured single-file application (~1200 lines) with inline theme system
- Tauri detection: `window.__TAURI_INTERNALS__` check for IPC vs mock mode
- Theme tokens (dark/light) defined as JS objects, applied via inline styles
- Supports multi-tab sessions with tab bar, message list, input area
- Inline component definitions: `AgentCard`, `ToolCallRow`, `MemoryRow`, `EvidenceSummary`, `AgentModeBar`, `ShortcutsBar`

**Components (`apps/clui/src/components/`):**

| Component | Purpose |
|-----------|---------|
| `MessageList.tsx` | Scrollable message thread with role-based styling |
| `StatusBar.tsx` | Session metadata, model info, token count |
| `ThinkingView.tsx` | Animated thinking/loading indicator |
| `EvidencePanel.tsx` | Collapsible sidebar showing evidence badges, grouped by type, confidence meter |
| `PlanKanban.tsx` | Three-column kanban (Planned / In Progress / Done) with Framer Motion layout animations |
| `AuthGate.tsx` | Device code flow UI for Clerk authentication |
| `SettingsPanel.tsx` | Model selection, theme, preferences |

**Stores (`apps/clui/src/stores/`):**

| Store | State Shape | Persistence |
|-------|-------------|-------------|
| `session-store.ts` | `sessions: Record<id, SessionState>`, `activeSessionId` | In-memory (per window lifecycle) |
| `preferences-store.ts` | `theme`, `activeModel`, `savedModels`, `showEvidencePanel`, `showKanban`, `usage` | localStorage (`8gent-clui-preferences`) |
| `auth-store.ts` | `stateName`, `user`, `deviceCode`, `isAuthenticated` | Keychain via `@8gent/auth` |

**Hooks:**
- `useConvexSync.ts` -- Optional Convex cloud sync when authenticated

---

## 3. Data Flow

### 3.1 User Message Flow

```
User types in input
       |
       v
React: useSessionStore.sendMessage(sessionId, content)
       |
       v
Tauri IPC: invoke("send_to_agent", { session_id, content })
       |
       v
Rust: AgentManager.send_input() -> write to child stdin
       |
       v
Bridge: readline gets line -> chatStream(prompt)
       |
       v
Bridge: POST /api/chat (stream: true) to Ollama
       |
       v
Ollama streams NDJSON chunks back
       |
       v
Bridge: emit({ type: "text", content: token }) per chunk
       |
       v
Rust: reader thread parses NDJSON -> app.emit_to("main", "agent_event", payload)
       |
       v
React: listen("agent_event") -> dispatch to session store
       |
       v
React: MessageList re-renders with streaming tokens
```

### 3.2 Permission Flow

```
Agent subprocess about to call a destructive tool
       |
       v
Agent: POST /approve { tool: "write_file", input: {...}, session_id }
       |
       v
PermissionServer: check_auto_approve(tool_name)
       |
       +-- If auto-approved -> respond { approved: true }
       |
       +-- If must ask:
           |
           v
           Tauri event: "permission_request" -> React
           |
           v
           React: PermissionDialog renders with tool details
           |
           v
           User clicks Approve/Deny
           |
           v
           React: invoke("respond_to_permission", { request_id, approved })
           |
           v
           Rust: PermissionServer.respond() -> HTTP response to agent
           |
           v
           Agent proceeds or aborts tool call
```

### 3.3 Voice Input Flow

```
User presses voice hotkey
       |
       v
VoiceEngine.startRecording()
       |
       v
MicRecorder (sox) captures WAV to temp file
       |
       +-- VoiceActivityDetector monitors energy levels
       |
       v
User releases / silence detected
       |
       v
VoiceEngine.stopRecording()
       |
       v
transcribeLocal(wavPath) via whisper.cpp binary
  OR  transcribeCloud(wavPath) via OpenAI Whisper API
       |
       v
emit("final-transcript", { text })
       |
       v
Transcript injected into chat input -> sent as user message
```

---

## 4. State Management Strategy

### Zustand Store Architecture

Three stores with distinct lifecycles and persistence strategies:

**`useSessionStore`** -- Ephemeral, in-memory only.
- One entry per active agent session tab
- Tracks: messages, status, processingStage, toolCalls, stepCount, toolCount, totalTokens
- Max 10 concurrent sessions
- No persistence -- sessions are recreated on app restart
- Streaming support: `updateStreamingMessage()` / `finalizeStreamingMessage()` for token-by-token updates

**`usePreferencesStore`** -- Persisted to localStorage, optionally synced to Convex.
- Theme mode (dark/light/system)
- Active model config with provider/endpoint/apiKey
- Preset model library (Ollama, OpenRouter, LM Studio)
- UI panel visibility toggles
- Usage statistics (populated from Convex when authenticated)
- Merge strategy: local always wins, cloud syncs asynchronously

**`useAuthStore`** -- Persisted to OS Keychain via `@8gent/auth`.
- State machine: unknown -> anonymous | authenticated | logging_in | refreshing | error
- Device code flow for Clerk authentication
- Auth is always optional -- anonymous mode works by default
- Lazy-loads `@8gent/auth` to avoid blocking app startup

### State Update Patterns

All stores use Zustand's immer-free pattern with spread operators for immutable updates. Session state updates are granular -- individual fields can be updated without replacing the entire session object. This matters because streaming updates happen at token frequency (dozens per second).

---

## 5. Transcription / Recording Architecture

### Dependencies

| Component | Binary | Install |
|-----------|--------|---------|
| Audio recording | sox | `brew install sox` (macOS) |
| Local transcription | whisper.cpp | `brew install whisper-cpp` |
| Cloud transcription | OpenAI API | `OPENAI_API_KEY` env var |
| Voice Activity Detection | Built-in | Energy-threshold algorithm |

### Pipeline

```
                          +------------------+
                          |  VoiceEngine     |
                          |  (orchestrator)  |
                          +--------+---------+
                                   |
               +-------------------+-------------------+
               |                   |                   |
      +--------v-------+  +-------v--------+  +-------v--------+
      | MicRecorder     |  | Whisper Model  |  | VAD            |
      | (sox subprocess)|  | Manager        |  | (energy-based) |
      +--------+-------+  +-------+--------+  +-------+--------+
               |                   |                   |
               v                   v                   v
          /tmp/*.wav          ~/.8gent/models/     processLevel()
               |              ggml-*.bin           -> speech-start
               |                   |               -> speech-end
               +----->  transcribeLocal()
                    OR  transcribeCloud()
                              |
                              v
                     { text, confidence }
```

### Recording Location

- WAV files: OS temp directory (`/tmp/8gent-voice-*.wav`)
- Auto-deleted after transcription
- Whisper models: `~/.8gent/models/` (auto-downloaded on first use)
- Model sizes: tiny (75MB), base (148MB), small (488MB), medium (1.5GB)

### VoiceEngine Configuration

```typescript
interface VoiceConfig {
  enabled: boolean;
  mode: "local" | "cloud";
  model: "tiny" | "base" | "small" | "medium";
  language: string;            // e.g., "en"
  maxRecordingSeconds: number; // default: 120
  vadEnabled: boolean;
  vadSilenceMs: number;        // silence threshold: default 1500ms
  modelsPath: string;
  openaiApiKey?: string;
}
```

### CLUI Integration Point

The VoiceEngine is a standalone package (`packages/voice/`). In CLUI v2, integration happens through a React hook that:
1. Instantiates `VoiceEngine` on mount
2. Listens for `final-transcript` events
3. Pipes transcript text into the active session's input
4. Renders recording state (idle/recording/transcribing) in the StatusBar

---

## 6. Permission UX Flow

### Trust Tiers

| Tier | Tools | Approval |
|------|-------|----------|
| **Read** | `read_file`, `list_directory`, `search_*`, `get_outline`, `get_symbol` | Auto-approved |
| **Write** | `write_file`, `edit_file` | Ask (default) |
| **Execute** | `exec`, `run_command`, `bash` | Always ask |
| **Network** | `web_search`, `fetch` | Ask (default) |
| **Destructive** | `delete_file`, `git push --force` | Always ask, with warning |

### User Controls

1. **Per-request dialog:** Tool name, input preview, approve/deny buttons
2. **"Always allow" checkbox:** Adds an `AlwaysApprove` rule for that tool pattern
3. **"Allow for session" option:** Temporary rule scoped to active session
4. **Settings panel:** Manage auto-approve rules, view audit log
5. **Bulk approve:** When multiple permissions queue, batch approval UI

### Implementation Status

The permission server (`permissions.rs`) has the data structures and rule matching implemented. The HTTP server (axum on ephemeral port) is scaffolded but not yet wired. The bridge does not yet POST to the permission endpoint before tool execution. This is a v2 priority.

---

## 7. IPC Contract

### Tauri Invoke Commands (Frontend -> Rust)

```typescript
// Session Management
invoke("create_session", { model?: string, cwd?: string }): Promise<string>
invoke("send_to_agent", { session_id: string, content: string }): Promise<void>
invoke("close_session", { session_id: string }): Promise<void>
invoke("list_sessions"): Promise<string[]>

// Permissions
invoke("respond_to_permission", { request_id: string, approved: boolean }): Promise<void>
```

### Tauri Events (Rust -> Frontend)

```typescript
// Agent events (multiplexed by session_id)
listen("agent_event", (event: {
  session_id: string,
  event: {
    type: "session_start" | "ready" | "thinking" | "text" | "assistant_message"
        | "error" | "session_end" | "stderr",
    [key: string]: any  // type-specific payload via serde flatten
  }
}) => void)

// Permission request
listen("permission_request", (event: PermissionRequest) => void)

// Tray menu actions
listen("tray_new_session", () => void)
```

### Environment Contract (Rust -> Bridge subprocess)

| Variable | Required | Purpose |
|----------|----------|---------|
| `EIGHT_SESSION_ID` | Yes | Session identifier for event routing |
| `EIGHT_MODEL` | Yes | Model name for Ollama (`qwen3.5`, `eight:latest`, etc.) |
| `EIGHT_OUTPUT_FORMAT` | Yes | Always `ndjson` |
| `EIGHT_CLUI_MODE` | Yes | Always `true` -- enables CLUI-specific behavior |
| `EIGHT_REPO_ROOT` | Yes | Absolute path to monorepo root |
| `OLLAMA_URL` | No | Default: `http://localhost:11434` |

---

## 8. Proactive Feature Surfacing Strategy

### The Problem

CLUI has deep capabilities (voice input, evidence validation, kanban planning, multi-avenue tracking) that users will never discover through a chat-only interface. The agent must proactively surface these features.

### Strategy: Context-Triggered Feature Cards

The `ProactivePlanner` and `AvenueTracker` from `@8gent/planning` drive surfacing decisions:

**ProactivePlanner** maintains a Kanban board of predicted next steps:
- `backlog`: Predicted future tasks (up to 10)
- `ready`: High-confidence next actions (up to 5)
- `inProgress` / `done`: Execution tracking
- Predictions are context-aware: git state, recent commands, errors, modified files
- Momentum tracking: steps/minute, streak count

**AvenueTracker** maintains multiple possible user directions:
- Up to 5 concurrent avenues (feature, bugfix, refactor, explore, test)
- Each avenue has a pre-generated plan with estimated tokens and time
- Trigger-word matching to auto-detect which avenue the user chose
- Probability calculation based on historical user patterns

### Surfacing Mechanisms

| Mechanism | What it surfaces | Where in UI |
|-----------|-----------------|-------------|
| **PlanKanban component** | ProactivePlanner board state | Collapsible right panel |
| **EvidencePanel component** | Validation results with pass/fail badges | Collapsible right panel |
| **AgentModeBar** | Current processing stage (planning/toolshed/executing/complete) | Below chat input |
| **ShortcutsBar** | Available keyboard shortcuts | Bottom of window |
| **Ready step suggestions** | High-confidence next actions from ProactivePlanner | Inline cards in chat |
| **Avenue cards** | Alternative directions from AvenueTracker | Above chat input when multiple paths detected |
| **Voice indicator** | Recording/transcribing state from VoiceEngine | StatusBar icon |
| **Permission badge** | Pending approval count | StatusBar badge |

### Feature Discovery Flow

```
1. User sends first message
   -> Agent responds + ProactivePlanner generates predictions
   -> Ready steps appear in PlanKanban (if panel open)
   -> AgentModeBar shows current stage

2. Agent executes tool calls
   -> EvidenceCollector gathers proof
   -> EvidencePanel updates with pass/fail badges
   -> ToolCallRow in chat shows tool name, status, duration

3. User seems uncertain (short messages, questions)
   -> AvenueTracker generates multiple directions
   -> Avenue cards appear suggesting paths
   -> User clicks one -> that avenue activates

4. Post-modification context
   -> ProactivePlanner predicts: run tests, check types, commit
   -> Ready steps appear as suggestion chips
   -> One-click to execute predicted step

5. Error occurs
   -> ProactivePlanner predicts debug steps
   -> Research avenue activates if web search patterns detected
   -> Evidence panel highlights failure evidence
```

### Notification Strategy

- **Non-intrusive:** Suggestions appear as cards/chips, never as blocking modals
- **Dismissible:** Every surfaced element can be collapsed or dismissed
- **Persistent toggles:** Panel visibility persists via preferences-store
- **Adaptive:** AvenueTracker learns from user pattern frequency over time

---

## 9. Technology Decisions and Tradeoffs

### Decision 1: Tauri 2.0 over Electron

| Factor | Tauri | Electron |
|--------|-------|----------|
| Bundle size | ~5MB | ~150MB+ |
| Memory footprint | ~30MB | ~200MB+ |
| Rust backend | Native, zero-overhead | N/A (Node.js backend) |
| WebView | System (WebKit on macOS, WebView2 on Windows) | Bundled Chromium |
| Plugin ecosystem | Growing (v2 plugins for shell, shortcuts, fs) | Mature |
| Tradeoff | System WebView means CSS quirks vary by OS | Consistent but heavy |

**Verdict:** Tauri wins for a developer desktop tool where bundle size and resource efficiency matter. The agent subprocess itself runs Bun (not Rust), so the backend stays thin.

### Decision 2: Bridge as Standalone Subprocess vs Embedded Runtime

**Chose:** Standalone Bun subprocess per session tab.

| Factor | Subprocess | Embedded (WASM/FFI) |
|--------|-----------|---------------------|
| Isolation | Full process isolation per session | Shared memory space |
| Crash handling | One session crash doesn't kill others | Panic propagates |
| Resource control | OS-level process limits, SIGTERM | Manual memory management |
| Overhead | ~30ms spawn, ~10MB per process | Near-zero |
| Debugging | stdout/stderr visible, can attach debugger | Harder to introspect |
| NDJSON protocol | Simple, language-agnostic | Not needed |

**Tradeoff:** Memory overhead of multiple Bun processes (10 sessions = ~100MB). Acceptable for a desktop app. The simplicity of stdio NDJSON and process-level isolation outweighs the cost.

### Decision 3: NDJSON over WebSocket or gRPC

| Factor | NDJSON via stdio | WebSocket | gRPC |
|--------|-----------------|-----------|------|
| Complexity | Minimal -- JSON.stringify per line | Connection management, reconnect | Proto definitions, codegen |
| Streaming | Natural (line-buffered) | Natural (frames) | Natural (streams) |
| Debugging | `cat` / `jq` on stdout | DevTools Network tab | grpcurl |
| Cross-language | Universal | Nearly universal | Requires protobuf |

**Verdict:** NDJSON via stdio is the simplest protocol that works. The bridge is the only consumer, and it runs as a child process. No network stack needed.

### Decision 4: Zustand over Redux / Jotai / Signals

**Chose:** Three separate Zustand stores.

- Minimal boilerplate (no actions/reducers/providers)
- TypeScript inference works naturally with `create<StoreType>`
- Granular subscriptions via selectors (important for streaming token updates)
- No context providers needed -- stores are importable singletons
- Devtools support via `zustand/middleware`

**Tradeoff:** No built-in undo/redo or time-travel debugging. Not needed for a chat application.

### Decision 5: Monorepo Packages as Optional Dependencies

`@8gent/voice`, `@8gent/planning`, and `@8gent/validation` are separate packages, not bundled into the bridge. This means:

- **Bridge is minimal:** Only chat streaming, no tool execution or voice
- **CLUI frontend imports packages directly:** React components for evidence panel, kanban, etc.
- **Graceful degradation:** If a package fails to load (e.g., voice without sox), the feature is hidden, not the app

**Tradeoff:** The bridge currently only does chat completion. Tool execution, evidence collection, and planning must be wired through additional IPC channels or by replacing the bridge with the full `@8gent/eight` engine. This is the primary v2 work item.

### Decision 6: Authentication is Always Optional

- Anonymous mode works out of the box -- no signup required
- Auth adds: cloud preference sync, usage tracking, team features
- Clerk device code flow (no browser redirect needed from a desktop app)
- Tokens persisted in OS Keychain via `@8gent/auth`
- Auth store lazy-loads the auth package to avoid blocking app startup

---

## 10. Open Architecture Questions for v2

1. **Bridge evolution:** Should the bridge be replaced with the full `@8gent/eight` engine (which has tool execution, planning, evidence collection)? Or should those capabilities be added incrementally via new NDJSON event types?

2. **Permission server wiring:** The HTTP server scaffold exists but the bridge does not yet call it. Should the permission check be a Tauri IPC call from the bridge, or a localhost HTTP endpoint as designed?

3. **Voice integration surface:** Should voice recording/transcription run in the Rust backend (via a Tauri command that invokes sox/whisper) or in the React frontend (via a Web Audio API + WebSocket to a local transcription server)?

4. **Session persistence:** Should session message history persist across app restarts? If so, where -- SQLite via Tauri plugin, or the filesystem as NDJSON session logs?

5. **Multi-window:** Should CLUI support detaching session tabs into separate windows? Tauri 2.0 supports multi-window, but the current store architecture assumes a single window.

6. **OpenRouter integration:** The preferences store lists OpenRouter models, but the bridge only talks to Ollama. Adding OpenRouter support requires API key management and a different HTTP endpoint in the bridge.

---

## Appendix A: File Map

```
apps/clui/
  bridge.ts                      # Standalone NDJSON bridge (Bun)
  src/
    main.tsx                     # React entry
    App.tsx                      # Full app shell with inline components
    App.full.tsx                 # Alternative full app layout
    stores/
      session-store.ts           # Multi-tab session state (Zustand)
      auth-store.ts              # Authentication state (Zustand)
      preferences-store.ts       # User preferences (Zustand + localStorage)
    hooks/
      useConvexSync.ts           # Optional Convex cloud sync
    components/
      MessageList.tsx            # Chat message thread
      StatusBar.tsx              # Session metadata bar
      ThinkingView.tsx           # Loading animation
      EvidencePanel.tsx          # Evidence sidebar (Framer Motion)
      PlanKanban.tsx             # Plan execution board (Framer Motion)
      AuthGate.tsx               # Device code login UI
      SettingsPanel.tsx          # Model/theme preferences
  src-tauri/
    src/
      main.rs                   # Binary entry (calls lib::run)
      lib.rs                    # Tauri setup, IPC commands, tray, shortcuts
      agent.rs                  # AgentManager, subprocess lifecycle, NDJSON reader
      permissions.rs            # PermissionServer, auto-approve rules
    tauri.conf.json             # App identity, window config, plugins
    gen/schemas/capabilities.json  # Tauri capability declarations

packages/
  eight/
    clui-bridge.ts              # Secondary bridge (monorepo-aware)
    prompts/system-prompt.ts    # Eight persona system prompt
  voice/
    index.ts                    # VoiceEngine orchestrator
    recorder.ts                 # MicRecorder (sox subprocess)
    transcriber.ts              # Local whisper.cpp transcription
    cloud-transcriber.ts        # OpenAI Whisper API fallback
    vad.ts                      # Energy-based voice activity detection
    model-manager.ts            # Whisper model download/management
    types.ts                    # VoiceConfig, events, states
  planning/
    index.ts                    # Re-exports
    proactive-planner.ts        # Kanban-based prediction engine
    avenue-tracker.ts           # Multi-direction plan tracking
  validation/
    index.ts                    # Re-exports
    evidence.ts                 # EvidenceCollector (file, git, command, test)
    report.ts                   # ValidationReporter
```
