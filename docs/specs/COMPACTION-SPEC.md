# Context Compaction Spec

> Issue #936 - LLM-summarized context management for long sessions

## Problem

Long sessions exhaust the context window. The agent loses early context and eventually errors out. We need to compress old messages into a summary while preserving recent work and file tracking.

## Constraint

Must work with any provider (Ollama local, OpenRouter cloud). No provider-specific APIs. Minimal blast radius - touches `agent.ts` message management and one new file.

## Not doing

- Session branching/tree navigation (Pi feature, not needed yet)
- Persistent cross-session memory (already handled by `packages/memory/`)
- Prompt caching integration (provider-specific, out of scope)

## Success metric

Sessions that previously failed at ~120k tokens can continue indefinitely with <2s compaction latency using local models.

---

## 1. Trigger

Compaction fires when estimated context tokens exceed `contextWindow - reserveTokens`.

```
shouldCompact = estimatedTokens > (contextWindow - reserveTokens)
```

Check runs after every assistant response, before the next user turn.

**Defaults:**
- `reserveTokens`: 16384 (headroom for next response)
- `keepRecentTokens`: 20000 (messages to preserve verbatim)
- `contextWindow`: auto-detected from model config, fallback 32768

---

## 2. Token Estimation

Use `Math.ceil(text.length / 4)` heuristic (conservative, no tokenizer dependency). For messages after the last assistant response with usage data, use actual `usage.totalTokens` from the AI SDK response and only estimate trailing messages.

---

## 3. Strategy

### Cut point selection

Walk backwards from newest message, accumulating token estimates. Stop when accumulated >= `keepRecentTokens`. That index is the cut point.

**Rules:**
- Never cut at a tool result (must follow its tool call)
- Cut at user or assistant message boundaries
- If cut falls mid-turn (between user message and its assistant response), keep the full turn

### Summarization

Send messages-to-discard to the LLM with a structured summarization prompt. Use the same model the agent is running on (no extra config needed).

If a previous compaction summary exists, use the UPDATE prompt to merge incrementally rather than re-summarizing everything.

---

## 4. Preservation

**Always kept intact (never summarized):**
- System prompt (index 0)
- Last N messages totaling ~`keepRecentTokens`
- The compaction summary message itself (injected as a system-role message after the system prompt)

**Summarized and discarded:**
- All messages between the system prompt and the cut point

---

## 5. File Tracking

Track files read and modified across compaction boundaries. Extract from tool calls in discarded messages and carry forward.

```typescript
interface FileTracker {
  read: Set<string>;    // files read via read_file, cat, etc.
  modified: Set<string>; // files written via write_file, edit, bash writes
}
```

File lists are appended to the compaction summary so the agent knows what files it has touched even after old messages are discarded.

Appended to summary as `## Files Touched` with `### Read` and `### Modified` subsections.

---

## 6. Compaction Prompt Template

Both initial and incremental compaction use the same output format. The incremental variant wraps the previous summary in `<previous-summary>` tags and instructs the LLM to merge rather than create fresh.

```
<conversation>{serialized messages}</conversation>
[<previous-summary>{prior summary}</previous-summary>]  // incremental only

[Create | Update] a structured context checkpoint for another LLM to continue.
Preserve exact file paths, function names, and error messages.

## Goal        - what the user is trying to accomplish
## Constraints - requirements and preferences mentioned
## Progress    - Done [x], In Progress [ ], Blocked
## Decisions   - key choices with brief rationale
## Next Steps  - ordered list of what should happen next
## Context     - data, examples, references needed to continue
```

---

## 7. TypeScript Types

```typescript
// packages/eight/compaction.ts

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  contextWindow: number; // 0 = auto-detect from model
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  contextWindow: 0,
};

export interface CompactionResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved: number;
  filesRead: string[];
  filesModified: string[];
}

export interface CompactableMessage {
  role: string;
  content: string | unknown[];
}

export interface FileTracker {
  read: Set<string>;
  modified: Set<string>;
}
```

---

## 8. Config

User config in `~/.8gent/config.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "contextWindow": 0
  }
}
```

`contextWindow: 0` means auto-detect from the model's reported context length.

---

## 9. Implementation Plan

**Files to create:**
- `packages/eight/compaction.ts` - all compaction logic (estimator, cut point, summarizer, file tracker)

**Files to modify:**
- `packages/eight/agent.ts` - add compaction check after each assistant response, inject summary into messageHistory
- `packages/eight/types.ts` - add CompactionConfig to AgentConfig

### Integration point

In `agent.ts` `processMessage()`, after assistant response is pushed to `messageHistory`: estimate tokens, check `shouldCompact()`, call `compactMessages()`, replace `messageHistory` with `[systemPrompt, summaryMsg, ...keptMessages]`, fire `events.onCompaction()`.

### Estimated size

1 new file (~200 lines), 2 modified files (~30 lines). Total blast radius: 3 files.

Architecture reference: Pi coding agent (`@mariozechner/pi-coding-agent/dist/core/compaction/`).
