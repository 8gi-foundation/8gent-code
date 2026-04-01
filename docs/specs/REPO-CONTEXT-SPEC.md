# Repo Context Mapping Spec

> Issue #952 - Intelligent repository context selection for the agent

## Problem

The agent wastes tokens reading irrelevant files or guesses which files matter. We need an automated repo context map that ranks files by relevance to the current task and selects the highest-value context within a token budget.

## Constraint

Must work on first run without a pre-built index. Tree-sitter parsing for structure, but graceful fallback to regex-based extraction for unsupported languages. Builds on existing `packages/ast-index/` (dep-graph, blast-radius, test-map).

## Not doing

- Full semantic code search (embeddings-based - that's the memory layer's job)
- Cross-repo context (single repo only)
- IDE integration or file watching daemon
- Caching across sessions (rebuild per session, it's fast enough)

## Success metric

Agent's system prompt includes the top-ranked files for a given task query, staying within a configurable token budget (default 8000 tokens). Relevance is measurably better than "just read the whole repo" - measured by whether the agent asks for fewer follow-up file reads.

---

## 1. Parsing Layer

Tree-sitter extracts structural information per file:

```typescript
interface FileNode {
  path: string;
  language: string;
  symbols: Symbol[];        // functions, classes, interfaces, exports
  imports: string[];        // imported modules/files
  exports: string[];        // exported symbol names
  loc: number;              // lines of code
  lastModified: number;     // mtime from fs
}

interface Symbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "export";
  line: number;
  signature?: string;       // e.g. "async function foo(bar: string): Promise<void>"
}
```

Supported tree-sitter grammars: TypeScript, JavaScript, Python, Rust, Go. Fallback: regex-based extraction for other languages (function/class declarations).

---

## 2. Import/Reference Graph

Extends `packages/ast-index/dep-graph.ts` to build a directed graph of file dependencies:

```typescript
interface RepoGraph {
  files: Map<string, FileNode>;
  edges: Map<string, string[]>;  // file -> files it imports
  reverseEdges: Map<string, string[]>;  // file -> files that import it
}
```

---

## 3. Relevance Ranking Algorithm

Given a task query (user message or tool context), rank files by combined score:

```
score(file) = w1 * textMatch(query, file)
            + w2 * importDistance(file, recentFiles)
            + w3 * recency(file.lastModified)
            + w4 * centrality(file, graph)
            + w5 * recentlyTouched(file, session)
```

| Factor | Weight | Description |
|--------|--------|-------------|
| textMatch | 0.35 | FTS match of query terms against file path + symbol names |
| importDistance | 0.25 | Shortest path in import graph from recently-read files |
| recency | 0.15 | File modification time (prefer recently changed files) |
| centrality | 0.15 | Number of reverse edges (more importers = more central) |
| recentlyTouched | 0.10 | Files the agent read/wrote this session |

---

## 4. Token-Budgeted Selection

Walk ranked files top-down, accumulating estimated tokens until budget is reached:

```typescript
interface ContextSelection {
  files: SelectedFile[];
  totalTokens: number;
  budget: number;
}

interface SelectedFile {
  path: string;
  score: number;
  content: string;   // full file or outline-only depending on token budget
  mode: "full" | "outline";  // outline = signatures only, saves tokens
}
```

Strategy:
1. Include top file in full if it fits the budget
2. Switch to outline-only mode when budget is tight
3. Always include files the user explicitly mentioned
4. Cap at 20 files regardless of budget

---

## 5. Auto-Refresh

Re-rank on:
- New user message (query terms change)
- After tool calls that read/write files (session context changes)
- After git operations (file graph may have changed)

No file watcher. Poll mtime on re-rank only.

---

## 6. System Prompt Integration

Inject ranked context into the system prompt as a `REPO_CONTEXT` segment, structured as:

```
## Repo Context (auto-selected, {n} files, {tokens} tokens)

### path/to/file.ts (score: 0.87)
[full content or outline]

### path/to/other.ts (score: 0.72)
[full content or outline]
```

---

## 7. Files to Create/Modify

**Create:**
- `packages/ast-index/tree-sitter-parser.ts` - tree-sitter extraction, fallback regex (~180 lines)
- `packages/ast-index/ranker.ts` - relevance scoring algorithm (~120 lines)
- `packages/ast-index/context-selector.ts` - token-budgeted file selection (~80 lines)

**Modify:**
- `packages/ast-index/dep-graph.ts` - expose reverse edges, centrality scores (~20 lines)
- `packages/ast-index/index.ts` - export new modules (~10 lines)
- `packages/eight/prompts/system-prompt.ts` - inject REPO_CONTEXT segment (~25 lines)
- `packages/eight/agent.ts` - trigger re-rank after tool calls (~15 lines)

## 8. Estimated Effort

3 new files (~380 lines), 4 modified files (~70 lines). Total: ~450 lines across 7 files.

Architecture reference: Aider's repo-map with tree-sitter ranking. Also inspired by Cursor's codebase indexing and Sourcegraph's code graph for relevance scoring.
