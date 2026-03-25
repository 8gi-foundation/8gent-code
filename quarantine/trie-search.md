# trie-search

**Tool name:** trie-search
**File:** `packages/tools/trie-search.ts`
**Status:** quarantine

## Description

Prefix trie data structure for fast autocomplete suggestions, command lookup, and prefix-based filtering in agent interfaces. Supports insert, exact search, prefix check, autocomplete suggestions, deletion, and word count. Self-contained, zero dependencies, ~120 lines TypeScript.

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `insert` | `(word: string) => void` | Add a word to the trie |
| `search` | `(word: string) => boolean` | Check if exact word exists |
| `startsWith` | `(prefix: string) => boolean` | Check if any word has this prefix |
| `suggest` | `(prefix: string, limit?: number) => string[]` | Return up to N words matching prefix |
| `delete` | `(word: string) => boolean` | Remove a word; returns true if it existed |
| `wordCount` | `() => number` | Total unique words stored |

## Integration Path

1. Wire into the agent command palette - index all known slash-commands on startup, call `suggest()` as the user types.
2. Use in shell autocomplete - feed PATH binaries into trie, surface suggestions on partial input.
3. Memory search pre-filter - before hitting FTS5, trie filters candidate keys to reduce query surface.
4. Tool name disambiguation - when user input partially matches multiple tools, `suggest()` returns ranked candidates for the AI judge to resolve.
