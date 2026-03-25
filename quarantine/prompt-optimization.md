# Prompt Optimization Tracker

**Status:** Quarantine - not wired into agent loop yet.
**Package:** `packages/self-autonomy/prompt-tracker.ts`
**Storage:** `~/.8gent/prompt-history.json`

## What It Does

Tracks system prompt effectiveness over time. Every prompt sent to a model gets logged with its outcome (success/failure/partial) and task category. Over time, the tracker identifies which prompt variations work best and flags failure patterns.

## API

```ts
import {
  logPrompt,
  getCategoryStats,
  getFailurePatterns,
  generateReport,
} from "./packages/self-autonomy/prompt-tracker.js";

// Log a prompt after a task completes
logPrompt("code-gen", systemPromptText, "success", "Generated correct code on first try", 1200);

// Get per-category success rates
const stats = getCategoryStats();

// Detect repeated failure patterns
const patterns = getFailurePatterns();

// Full effectiveness report
const report = generateReport();
```

## Data Model

Each entry stores:
- Task category (code-gen, refactor, debug, explain, etc.)
- Prompt hash and preview (for deduplication and readability)
- Full prompt text
- Outcome: success, failure, or partial
- Optional notes and duration

## Integration Plan

1. Wire `logPrompt()` into agent loop after each task completion
2. Surface `generateReport()` via a `/prompt-stats` CLI command
3. Use best-performing prompt hashes to auto-select prompt variants per category
4. Feed failure patterns into the reflection system for self-improvement

## Why Quarantine

Needs real usage data before the suggestions are meaningful. The tracker itself is complete and tested, but wiring it into the agent loop should wait until the core agent loop is stable.
