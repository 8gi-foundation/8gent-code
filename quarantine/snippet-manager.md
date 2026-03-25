# Quarantine: Snippet Manager

**Package:** `packages/tools/snippet-manager.ts`
**Status:** Quarantined - not wired into agent tools or TUI yet.

## Problem

Agents and users frequently reuse code patterns (boilerplate, config templates, common fixes). There is no way to save and recall these within the 8gent ecosystem.

## What It Does

- **Save** named code snippets with language and tags
- **List** all saved snippets (metadata view)
- **Get** full snippet by ID
- **Search** across title, tags, code, and language
- **Filter** by tags (AND logic)
- **Copy** snippet code to macOS clipboard via pbcopy
- **Delete** snippets by ID

## Storage

Individual JSON files in `~/.8gent/snippets/`. Each file is `{id}.json` containing title, code, language, tags, and timestamp.

## API

```ts
import {
  saveSnippet,
  listSnippets,
  getSnippet,
  deleteSnippet,
  searchSnippets,
  filterByTags,
  copyToClipboard,
} from "./packages/tools/snippet-manager";

// Save
const s = saveSnippet({ title: "fetch wrapper", code: "...", language: "ts", tags: ["http"] });

// List all
const all = listSnippets(); // returns metadata only, no code

// Get by ID
const snippet = getSnippet(s.id);

// Search
const results = searchSnippets("fetch");

// Filter by tags
const tagged = filterByTags(["http", "ts"]);

// Copy to clipboard
copyToClipboard(s.id);

// Delete
deleteSnippet(s.id);
```

## Exit Criteria

To move out of quarantine:

1. Wire as agent tool definitions in `packages/eight/tools.ts`
2. Add TUI command or slash-command integration
3. Add basic tests (save/get/search/delete round-trip)
4. Confirm no performance issues with 100+ snippets
