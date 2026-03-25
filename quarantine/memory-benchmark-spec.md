# Memory Persistence Benchmark - Test Design

**File:** `benchmarks/categories/abilities/memory-persistence.ts`
**Tests:** `packages/memory/store.ts` + `packages/memory/types.ts`

## Problem

No automated test validates that the memory store can persist, search, decay, and delete memories correctly. This benchmark covers the core memory lifecycle without requiring an LLM or embedding provider.

## What it tests

| # | Test | What it proves |
|---|------|---------------|
| 1 | Store and recall by ID | `write()` persists to SQLite, `get()` retrieves with correct data |
| 2 | FTS semantic search | `recall()` returns relevant results ranked by BM25 via FTS5 |
| 3 | Contradiction detection | Knowledge graph relationships can flag conflicting facts |
| 4 | Memory decay over time | `effectiveImportance()` scores fresh memories higher than 90-day-old ones |
| 5 | Soft delete hides memory | `forget()` soft-deletes, `get()` returns null for deleted entries |
| 6 | Batch write + stats | `writeBatch()` inserts atomically, `getStats()` reports accurate counts |

## What it does NOT test

- Embedding/vector search (requires Ollama running)
- Consolidation pipeline (requires background jobs)
- Procedural memory step execution
- Multi-user scoping

## How to run

```bash
bun run benchmarks/categories/abilities/memory-persistence.ts
```

## Success criteria

All 6 tests pass. Exit code 0 on success, 1 on any failure.

## Design decisions

- Uses a real SQLite file in `/tmp` (not `:memory:`) to match production behavior with WAL mode.
- Cleans up the temp DB after each run.
- No LLM judge needed - all assertions are deterministic.
- Under 150 lines for the benchmark file.
