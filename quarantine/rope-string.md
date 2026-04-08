# rope-string

## Tool Name
`rope-string`

## Description
Rope data structure for efficient large text editing operations. A rope is a binary tree where leaf nodes hold short string segments and branch nodes store the combined length of their subtrees. This enables O(log n) insert, delete, substring, and charAt operations - far more efficient than naive string concatenation for large documents or repeated edits.

Key operations:
- `insert(idx, text)` - insert text at any position, O(log n)
- `delete(start, end)` - remove a range, O(log n)
- `substring(start, end)` - extract a slice, O(log n + k) where k is output length
- `charAt(idx)` - character lookup, O(log n)
- `concat(other)` - join two ropes, O(1)
- `rebalance()` - rebalance the tree for optimal depth, O(n)
- `toString()` - materialise to plain string, O(n)

Leaf nodes cap at 64 characters. Rebalancing splits text into 64-char chunks and builds a balanced binary tree.

## Status
**quarantine** - implemented and self-contained, not yet wired into the agent or any tool registry.

## Integration Path
1. Register in `packages/tools/index.ts` once that file exists.
2. Wire into the agent code-editing tool chain in `packages/eight/tools.ts` for large file edits.
3. Candidate use-case: patch application on files >10k characters where repeated `String.prototype.slice` chains create O(n) pressure per edit.
4. Consider exposing as MCP tools: `rope_insert`, `rope_delete`, `rope_view` for agent-driven large-file surgery.
