# tree-sitter-lite

## Description

Lightweight syntax tree builder for TypeScript and JavaScript. Tokenises source code line-by-line using regex patterns and builds a basic AST that captures top-level declarations: functions, classes, imports, exports, arrow functions, and class methods.

No native dependencies. No WASM. No build step. Runs anywhere Bun or Node runs.

## Status

**quarantine** - proof-of-concept, not wired into production paths.

## Exports

| Symbol | Description |
|--------|-------------|
| `parse(code: string): ParseResult` | Main entry point. Returns `{ root, nodes }`. |
| `filterNodes(result, kind)` | Returns all nodes of a given `NodeKind`. |
| `summarise(result)` | Human-readable summary of node counts. |
| `SyntaxNode` | `{ kind, name?, line, source, children }` |
| `ParseResult` | `{ root: SyntaxNode, nodes: SyntaxNode[] }` |

## Node kinds

`import` | `export` | `function` | `class` | `arrow-function` | `method` | `root`

## Integration path

1. **AST index** (`packages/ast-index/`) - replace or augment the current import-graph walk with `parse()` to get a richer symbol map without spawning a TypeScript compiler.
2. **Code tools** (`packages/tools/index.ts`) - expose as a registered tool so the agent can analyse files without reading them in full.
3. **Change-impact estimation** - feed parsed nodes into `packages/ast-index/` to detect which symbols a diff touches and estimate blast radius.

## Limitations

- Regex-based: does not handle multi-line declarations that span unusual patterns.
- No type resolution, no scope tracking, no expression trees.
- Intended for fast structural extraction, not full semantic analysis.
