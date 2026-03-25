# tree-walker

## Tool name
`walkTree` / `findInTree` / `filterTree` / `mapTree`

## Description
Generic tree traversal with visitor pattern. Zero external dependencies - pure TypeScript designed for AST, DOM, and any recursive node structure inside the 8gent agent runtime.

**Capabilities:**
- DFS (default) and BFS traversal
- Visitor pattern with `enter` / `leave` hooks per node
- Path tracking - every hook receives the full key path from root
- `skip` signal to prune a subtree, `stop` signal to halt traversal early
- `findInTree(root, predicate)` - first match, O(n) with early exit
- `filterTree(root, predicate)` - all matches, full walk
- `mapTree(root, mapper)` - structural transform returning a new tree

## Status
`quarantine`

## Integration path

**Target location:** `packages/tools/tree-walker.ts` (already placed)

**Candidate consumers:**

| Consumer | Use case |
|----------|----------|
| `packages/ast-index/` | Walk AST import graphs; replace ad-hoc recursion with typed visitors |
| `packages/eight/tools.ts` | Traverse tool-call trees to detect cycles or build execution plans |
| `packages/validation/` | Walk checkpoint diff trees to compute blast-radius before revert |
| `apps/tui/` | Walk component trees for accessibility audits or layout analysis |

**Integration steps:**
1. Wire into `packages/ast-index/` - replace recursive import-graph traversal with `walkTree` + `filterTree`
2. Add a `treeDepth(root)` utility on top of `walkTree` for complexity scoring
3. Expose `findInTree` via the agent tool registry so Eight can query node lookup at runtime

**Graduation criteria:**
- Consumed by at least one package with a measurable outcome (e.g. import-graph traversal test, cycle detection)
- `mapTree` used in at least one structural transform pipeline
- No new external deps introduced
