# Error Catalog - Quarantine Spec

## Status: Quarantine

Not yet wired into the agent loop or TUI. Needs review before promotion.

## What

Centralized error code registry (`packages/tools/error-catalog.ts`) with codes E001-E999 covering all 8gent subsystems. Each entry has a code, category, human-readable description, and a suggested fix.

## Categories

| Range | Category | Subsystem |
|-------|----------|-----------|
| E001-E099 | agent | Agent core loop, sessions, checkpoints |
| E100-E199 | tools | Tool registry, execution, sandbox |
| E200-E299 | memory | SQLite, FTS5, embeddings, consolidation |
| E300-E399 | permissions | NemoClaw policy engine, approval gates |
| E400-E499 | network | Ollama, OpenRouter, providers, WebSocket |
| E500-E599 | kernel | Training proxy, GRPO, LoRA, checkpoints |
| E600-E699 | tui | Terminal layout, Ink rendering, theme |
| E700-E799 | orchestration | Worktree pool, sub-agents, messaging |
| E800-E899 | browser | Fetch, HTML extraction, search |
| E900-E999 | daemon | Fly.io vessel, auth, agent pool |

## API

```ts
import { lookupByCode, searchErrors, listCategory, getCategories, getAllErrors } from "@8gent/tools/error-catalog";

// Lookup by exact code
lookupByCode("E200");
// => { code: "E200", category: "memory", description: "SQLite database locked", fix: "..." }

// Search by keyword
searchErrors("ollama");
// => [E203, E400, E402] - all entries mentioning Ollama

// List all errors in a category
listCategory("network");

// Get all category names
getCategories();
```

## Promotion Criteria

- [ ] Wire into agent error handler so thrown errors include the code
- [ ] Add `--explain E200` CLI command to the TUI
- [ ] Add error codes to tool execution failures in `packages/eight/tools.ts`
- [ ] Test coverage for lookup and search functions
