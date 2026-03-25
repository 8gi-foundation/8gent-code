# Quarantine: Session Export Utility

## What

`packages/tools/session-export.ts` - exports agent sessions to markdown, JSON, or HTML format. Includes conversation history, tool calls, files changed, and session duration.

## Status

Quarantined - new utility, no existing files modified.

## Usage

```typescript
import { exportSession, exportSessionToFile } from "./packages/tools/session-export";
import type { SessionData } from "./packages/tools/session-export";

const session: SessionData = {
  id: "abc-123",
  model: "qwen3.5:32b",
  startedAt: "2026-03-25T10:00:00Z",
  endedAt: "2026-03-25T10:05:30Z",
  messages: [
    { role: "user", content: "Fix the auth bug", timestamp: "2026-03-25T10:00:00Z" },
    {
      role: "assistant",
      content: "Found and patched the token validation.",
      timestamp: "2026-03-25T10:02:15Z",
      toolCalls: [{ name: "readFile", args: { path: "src/auth.ts" }, durationMs: 45 }],
    },
  ],
  filesChanged: ["src/auth.ts"],
};

// Export as markdown string
const md = exportSession(session, { format: "markdown" });

// Export as JSON string
const json = exportSession(session, { format: "json" });

// Export as HTML string
const html = exportSession(session, { format: "html" });

// Write directly to file
await exportSessionToFile(session, "./session-report.html", { format: "html" });
```

## Formats

| Format | Output | Use case |
|--------|--------|----------|
| `markdown` | `.md` with headers, lists, code blocks | Commit logs, PR descriptions, docs |
| `json` | Pretty-printed JSON | Programmatic consumption, archival |
| `html` | Self-contained dark-theme HTML page | Sharing, browser viewing |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `includeToolCalls` | `true` | List tool calls per message |
| `includeFilesChanged` | `true` | Show files changed section |
| `includeMetadata` | `true` | Append session metadata (markdown/json only) |

## Features

- Duration auto-formatted (seconds, minutes, hours)
- Tool call summary with counts per tool name
- HTML output uses brand accent (#E8610A), dark theme, responsive layout
- No external dependencies - pure TypeScript, uses only `Bun.write` for file output
- ~120 lines

## Integration Points

- Wire into `packages/eight/agent.ts` session lifecycle to auto-export on session end
- Feed into `packages/memory/` for session recall
- Use with `packages/self-autonomy/reflection.ts` to export reflection context
