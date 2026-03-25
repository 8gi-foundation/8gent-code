# clipboard-history

**Tool name:** ClipboardHistory

**Description:**
Maintains a searchable ring-buffer clipboard history for the agent. Supports push with automatic deduplication (by content hash), full-text substring search, recency queries, lookup by ID, and configurable max size. All entries are timestamped. No external dependencies.

**Status:** quarantine

**Integration path:**
1. Import `ClipboardHistory` from `packages/tools/clipboard-history.ts`.
2. Instantiate once per session (or persist via `packages/memory/store.ts` if cross-session history is needed).
3. Wire `push()` into the tool execution loop - call after any tool returns a text result the agent may want to reuse.
4. Expose `search()` and `recent()` as agent-callable tools so Eight can retrieve past clipboard content by query.
5. When confirmed stable, register in `packages/eight/tools.ts` and document in `docs/TOOLS.md`.
