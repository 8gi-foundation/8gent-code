# LSP Integration Spec

> Issue #939 - Language Server Protocol client for code intelligence

## Problem

The agent uses grep and AST parsing for code navigation. This works but misses type information, cross-file references, and diagnostics that language servers already provide. Adding LSP gives the agent IDE-grade intelligence without reimplementing each language's semantics.

## Constraint

Must not require users to install language servers manually. Auto-detect from project config (tsconfig.json, pyproject.toml, Cargo.toml) and use bundled or globally-available servers. Zero-config for the top 3 languages.

## Not doing

- Running LSP servers for every possible language (start with TS, Python, Rust)
- Real-time diagnostics streaming (poll on demand only)
- Code actions or refactoring via LSP (LATER)
- LSP-based completion for the user (this is for the agent's tools, not the TUI input)

## Success metric

Agent can resolve "go to definition" and "find references" for TypeScript symbols in <500ms using the LSP client, replacing grep-based guessing.

---

## 1. Architecture

```
Agent Tool Call
  -> packages/lsp/client.ts (LSP JSON-RPC client)
    -> spawns language server subprocess
    -> communicates via stdin/stdout JSON-RPC
    -> caches server instance per workspace root
```

The existing `packages/lsp/index.ts` is the integration point. The LSP client manages server lifecycle.

---

## 2. Auto-Detection

On session start (or first code-related tool call), scan project root for:

| File | Language | Server | Install |
|------|----------|--------|---------|
| `tsconfig.json` or `package.json` | TypeScript | `typescript-language-server` | bundled via npm |
| `pyproject.toml` or `setup.py` | Python | `pylsp` or `pyright` | check PATH, suggest pip install |
| `Cargo.toml` | Rust | `rust-analyzer` | check PATH, suggest rustup |

```typescript
interface LSPServerConfig {
  language: string;
  command: string;
  args: string[];
  rootUri: string;
  initOptions?: Record<string, unknown>;
}
```

---

## 3. Agent Tools Exposed

Four new tools registered in the agent tool set:

```typescript
// go_to_definition - resolve symbol location
{ symbol: string, file: string, line: number } -> { file: string, line: number, preview: string }

// find_references - find all usages
{ symbol: string, file: string, line: number } -> { references: Array<{ file, line, preview }> }

// hover_info - get type/doc info for a symbol
{ file: string, line: number, column: number } -> { type: string, documentation: string }

// get_diagnostics - get errors/warnings for a file
{ file: string } -> { diagnostics: Array<{ line, severity, message }> }
```

---

## 4. Server Lifecycle

```typescript
interface LSPClient {
  initialize(config: LSPServerConfig): Promise<void>;
  shutdown(): Promise<void>;
  isRunning(): boolean;

  // Core methods
  gotoDefinition(file: string, line: number, col: number): Promise<Location | null>;
  findReferences(file: string, line: number, col: number): Promise<Location[]>;
  hover(file: string, line: number, col: number): Promise<HoverResult | null>;
  diagnostics(file: string): Promise<Diagnostic[]>;

  // Document sync
  didOpen(file: string, content: string): void;
  didChange(file: string, content: string): void;
  didClose(file: string): void;
}
```

Servers are spawned lazily on first tool call and kept alive for the session. Killed on session end or after 5 minutes of inactivity.

---

## 5. Files to Create/Modify

**Create:**
- `packages/lsp/client.ts` - JSON-RPC client, server spawn, document sync (~250 lines)
- `packages/lsp/detect.ts` - auto-detect language servers from project files (~60 lines)
- `packages/lsp/types.ts` - LSP subset types needed (~40 lines)

**Modify:**
- `packages/lsp/index.ts` - export client, integrate with existing package (~20 lines)
- `packages/eight/tools.ts` - register 4 LSP tools (~40 lines)
- `packages/eight/agent.ts` - init LSP on session start, shutdown on end (~15 lines)

## 6. Estimated Effort

3 new files (~350 lines), 3 modified files (~75 lines). Total: ~425 lines across 6 files.

Architecture reference: Aider's LSP integration for repo-map context. Also inspired by Cursor's use of language servers for symbol resolution and Zed's built-in LSP multiplexer.
