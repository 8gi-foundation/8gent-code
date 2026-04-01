# ~/.8gent — Full Dossier

> Generated 2026-03-14. Complete analysis of the `~/.8gent` directory: structure, schemas, data, and runtime behavior.

---

## 1. Directory Structure

```
~/.8gent/
├── providers.json          # Active LLM provider configuration
├── hooks.json              # Lifecycle hook configuration
├── sessions/               # 22 JSONL files (656K total)
│   └── session_{ts}_{id}.jsonl
└── reports/                # 38 JSON files (152K total)
    └── report_{ts}_{id}.json
```

All IDs follow the pattern `{type}_{unixMs}_{6charAlphanumeric}`.

---

## 2. providers.json

Configures which LLM backend the agent uses.

### Current Contents

```json
{
  "activeProvider": "openrouter",
  "activeModel": "openai/gpt-4.1-mini",
  "providers": {
    "openrouter": {
      "enabled": true
    }
  }
}
```

### Schema (from `packages/providers/index.ts`)

```typescript
interface ProviderSettings {
  activeProvider: ProviderName;
  activeModel: string;
  providers: Record<ProviderName, ProviderConfig>;
}

type ProviderName =
  | "ollama" | "lmstudio" | "openrouter"
  | "groq" | "grok" | "openai" | "anthropic"
  | "mistral" | "together" | "fireworks" | "replicate";

interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}
```

Managed by the `ProviderManager` class which handles loading, saving, API key storage, and model discovery.

---

## 3. hooks.json

Lifecycle hooks that fire at specific agent events (before/after tool calls, on error, etc.).

### Current Contents

```json
{
  "hooks": [],
  "globalTimeout": 30000,
  "enabled": false
}
```

Hooks are currently disabled with none registered.

### Schema (from `packages/hooks/index.ts`)

```typescript
interface HooksConfig {
  hooks: Hook[];
  globalTimeout: number;   // ms, default 30000
  enabled: boolean;
}

interface Hook {
  name: string;
  type: HookType;
  command: string;           // shell command, script path, or function
  mode: "shell" | "script" | "function";
  enabled: boolean;
  timeout?: number;          // per-hook override
  conditions?: Record<string, unknown>;
}

type HookType =
  | "beforeTool" | "afterTool"
  | "onError" | "onComplete"
  | "beforeCommand" | "afterCommand"
  | "onStart" | "onExit";

interface HookContext {
  sessionId: string;
  workingDirectory: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
}

interface HookResult {
  hookName: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}
```

---

## 4. Session Files (`sessions/*.jsonl`)

Each session is a JSONL (JSON Lines) file — one JSON object per line, strictly ordered by `sequenceNumber`. The first line is always `session_start`, the last is `session_end`.

**22 sessions** recorded, totaling **612 lines** across all files.

### Schema Version History

- **v1 (legacy)**: Used "turns" as the loop unit. Entry types: `turn_start`, `turn_end`, `assistant_message`.
- **v2 (current)**: Aligned with Vercel AI SDK. Uses "steps" as the loop unit. Entry types: `step_start`, `step_end`, `assistant_content` with typed content parts.

Both versions share: `session_start`, `user_message`, `tool_call`, `tool_result`, `hook`, `error`, `session_end`.

### Base Entry

Every JSONL line has:

```typescript
interface BaseEntry {
  type: string;              // discriminator
  timestamp: string;         // ISO-8601
  sequenceNumber: number;    // 0-based, monotonically increasing
}
```

### Entry Type: `session_start` (seq 0, always first)

```typescript
{
  type: "session_start",
  meta: {
    sessionId: string,       // "session_{ts}_{id}"
    version: 1 | 2,
    startedAt: string,       // ISO-8601
    agent: {
      model: string,         // e.g. "openai/gpt-4.1-mini"
      runtime: "ollama" | "lmstudio" | "openrouter",
      maxTurns?: number,     // v1
      maxSteps?: number,     // v2
      systemPromptHash?: string
    },
    environment: {
      workingDirectory: string,
      gitBranch?: string,
      gitCommit?: string,
      platform?: "darwin" | "linux" | "win32",
      nodeVersion?: string
    }
  }
}
```

### Entry Type: `user_message`

```typescript
{
  type: "user_message",
  message: { role: "user", content: string }
}
```

### Entry Type: `tool_call` (v1 style, still emitted in v2)

```typescript
{
  type: "tool_call",
  toolCall: {
    toolCallId: string,
    name: string,            // e.g. "write_file", "run_command", "read_file"
    arguments: Record<string, unknown>,
    success: boolean,
    durationMs: number,
    startedAt?: string
  },
  stepNumber?: number        // v2 cross-reference
}
```

### Entry Type: `tool_result`

```typescript
{
  type: "tool_result",
  toolCallId: string,
  success: boolean,
  result?: string,           // stdout/file contents/etc.
  durationMs?: number,
  toolName?: string,         // v2
  stepNumber?: number        // v2
}
```

### Entry Type: `assistant_content` (v2 only)

Rich typed output from the model, replacing the flat `assistant_message` of v1.

```typescript
{
  type: "assistant_content",
  stepNumber: number,
  parts: ContentPart[],
  usage?: DetailedTokenUsage
}

type ContentPart =
  | { type: "text", text: string }
  | { type: "reasoning", text: string, signature?: string }
  | { type: "source", sourceType: string, id: string, url?: string, title?: string }
  | { type: "file", mediaType: string, data: string }          // base64
  | { type: "tool-call", toolCallId: string, toolName: string, args: Record<string, unknown> }
  | { type: "tool-result", toolCallId: string, toolName: string, result: unknown }
  | { type: "tool-error", toolCallId: string, toolName: string, error: string };
```

### Entry Type: `step_start` / `step_end` (v2 only)

```typescript
// step_start
{
  type: "step_start",
  stepNumber: number,
  model?: { provider: string, modelId: string },
  messageCount?: number
}

// step_end
{
  type: "step_end",
  stepNumber: number,
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other",
  usage?: DetailedTokenUsage,
  response?: {
    id?: string,
    timestamp?: string,
    modelId?: string,
    headers?: Record<string, string>
  },
  providerMetadata?: Record<string, unknown>
}
```

### Entry Type: `tool_error` (v2 only)

```typescript
{
  type: "tool_error",
  toolCallId: string,
  toolName: string,
  error: string,
  stepNumber?: number
}
```

### Entry Type: `session_end` (always last)

```typescript
{
  type: "session_end",
  summary: {
    endedAt: string,
    durationMs: number,
    totalTurns?: number,       // v1
    totalSteps?: number,       // v2
    totalToolCalls?: number,
    totalTokens?: number,      // v1 flat count
    totalUsage?: DetailedTokenUsage,  // v2 detailed
    filesCreated?: string[],
    filesModified?: string[],
    filesDeleted?: string[],
    gitCommits?: string[],
    exitReason: "user_exit" | "max_turns" | "max_steps" | "error" | "idle_timeout" | "completed",
    reportId?: string
  }
}
```

### Detailed Token Usage (used in step_end, assistant_content, session_end)

```typescript
interface DetailedTokenUsage {
  promptTokens?: number,
  completionTokens?: number,
  totalTokens: number,
  inputTokenDetails?: {
    noCacheTokens?: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number
  },
  outputTokenDetails?: {
    textTokens?: number,
    reasoningTokens?: number
  },
  raw?: Record<string, unknown>   // provider pass-through (includes cost data)
}
```

### Legacy v1 Entry Types (still parsed by reader)

| Type | Description |
|------|-------------|
| `turn_start` | Start of an agentic turn (turnIndex, messageCount) |
| `turn_end` | End of turn (reason: natural_stop/tool_calls/max_turns/error) |
| `assistant_message` | Flat string message with simple TokenUsage |
| `hook` | Hook execution record |
| `error` | Session error (message, code, stack, recoverable) |

---

## 5. Report Files (`reports/*.json`)

Completion reports generated at session end. Each is a standalone JSON file.

**38 reports** total.

### Schema (from `packages/reporting/types.ts`)

```typescript
interface StoredReport extends CompletionReport {
  version: number;           // currently 1
  storedAt: Date;            // ISO-8601 when written to disk
}

interface CompletionReport {
  id: string;                // "report_{ts}_{id}"
  taskId?: string;           // "task_{ts}_{id}"

  // Summaries
  summary: string;           // short (e.g. "modified 6 files.")
  detailedSummary?: string;  // full task description / prompt

  // File tracking
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];

  // Metrics
  toolsUsed: number;
  tokensUsed?: number;
  tokensSaved?: number;
  contextMax?: number;       // max context window (e.g. 128000)
  duration: string;          // human-readable ("3m 19s")
  durationMs: number;

  // Execution details
  steps: StepSummary[];
  evidence: EvidenceSummary[];

  // Git
  gitCommit?: string;
  gitBranch?: string;

  // Quality
  confidence: number;        // 0–100

  // Timing
  startedAt: Date;
  completedAt: Date;
  workingDirectory: string;

  // Error info
  error?: string;
  errorStack?: string;

  // Outcome
  status: "success" | "partial" | "failed";
}

interface StepSummary {
  index: number;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  duration?: number;
  toolsUsed?: string[];
  filesAffected?: string[];
  error?: string;
}

interface EvidenceSummary {
  type: "files_exist" | "build_passes" | "tests_pass" | "git_committed" | "server_running" | "custom";
  label: string;
  status: "pass" | "fail" | "pending" | "skipped";
  details?: string;
  url?: string;
}
```

### Supporting Types (input to the reporter)

```typescript
interface TaskContext {
  taskId: string;
  taskDescription: string;
  startTime: number;
  endTime?: number;
  workingDirectory: string;
  steps: TaskStep[];
  tools: ToolInvocation[];
  fileOperations: FileOperation[];
  gitBranch?: string;
  gitCommits?: string[];
  tokensUsed?: number;
  tokensSaved?: number;
  contextMax?: number;
  result?: string;
  error?: string;
  model?: string;
}

interface FileOperation {
  type: "create" | "modify" | "delete" | "read";
  path: string;
  timestamp: number;
}

interface ToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  duration: number;
  timestamp: number;
  success: boolean;
}
```

---

## 6. Aggregate Statistics (Current Data)

| Metric | Value |
|--------|-------|
| Total sessions | 22 |
| Total reports | 38 |
| Session disk usage | 656K |
| Report disk usage | 152K |
| All reports status | `success` (100%) |
| Confidence scores | 70 (31 reports), 100 (7 reports) |
| Shortest task | 995ms |
| Longest task | 5m 55s |
| Smallest token usage | 3,860 |
| Largest token usage | 473,223 |
| Provider used | OpenRouter (all sessions) |
| Model used | openai/gpt-4.1-mini (all sessions) |
| Working dirs | Mix of project root + temp dirs (`/tmp/8gent-test-*`, `/var/folders/.../T/8gent-test-*`) |

### Task Types Observed in Reports

- **Trivial/greeting**: ~18 reports with ~3,900 tokens, 1-5s duration, confidence 70 — likely "hi" or minimal prompts
- **Simple coding**: Fibonacci, file creation — ~10-15K tokens, 6-8s
- **Medium projects**: Next.js hello world, REST APIs — 22-54K tokens, 34s-1m42s
- **Complex multi-file**: Full-stack task management with 30 tests — 473K tokens, 3m19s, confidence 100
- **Challenging tasks**: 270-365K tokens, 1m25s-5m55s — likely multi-step API + test tasks

### Evidence Types Used

| Evidence Type | Occurrences |
|---------------|-------------|
| `files_exist` | All 38 reports |
| `build_passes` | Earlier reports (status: pending) |

---

## 7. Data Flow

```
User prompt
    │
    ▼
┌──────────────┐     writes JSONL      ┌──────────────────────┐
│  Agent Loop  │ ──────────────────────▶│ ~/.8gent/sessions/   │
│  (packages/  │                        │   session_*.jsonl     │
│   eight/)    │                        └──────────────────────┘
│              │
│  on exit:    │     writes JSON        ┌──────────────────────┐
│  reporter    │ ──────────────────────▶│ ~/.8gent/reports/    │
│              │                        │   report_*.json       │
└──────────────┘                        └──────────────────────┘
        │
        │ reads config
        ▼
  ~/.8gent/providers.json    (which model/provider to use)
  ~/.8gent/hooks.json        (lifecycle hooks to fire)
```

**Writer**: `SessionWriter` (in `packages/specifications/session/writer.ts`) — appends entries line-by-line.
**Reader**: `SessionReader` (in `packages/specifications/session/reader.ts`) — reads/streams entries, handles v1↔v2 compat.
**Reporter**: `CompletionReporter` (in `packages/reporting/completion.ts`) — generates reports from `TaskContext`.

---

## 8. ID Format Convention

All IDs across the system use `{type}_{unixTimestampMs}_{6charRandomAlphanumeric}`:

- Sessions: `session_1773416861283_2uwdeb`
- Reports: `report_1773415569016_7cbg01`
- Tasks: `task_1773415369523_afjef1`

---

## 9. Source of Truth Files

| Schema | Defined In |
|--------|-----------|
| Session JSONL entries | `packages/specifications/session/index.ts` |
| Session writer | `packages/specifications/session/writer.ts` |
| Session reader | `packages/specifications/session/reader.ts` |
| Completion reports | `packages/reporting/types.ts` |
| Report generator | `packages/reporting/completion.ts` |
| Provider config | `packages/providers/index.ts` |
| Hooks config | `packages/hooks/index.ts` |
