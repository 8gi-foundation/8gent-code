# interval-tree

## Tool Name
`IntervalTree`

## Description
Augmented BST for efficient range overlap queries. Supports:
- Insert interval with optional payload
- Query all intervals overlapping a range [low, high]
- Point query - all intervals containing a given point
- Remove interval by low/high/data identity
- `hasOverlap` - boolean fast path without collecting results
- `toArray` - in-order traversal of all stored intervals

Time complexity: O(log n) insert/remove, O(log n + k) overlap query (k = results). Space: O(n).

## Status
`quarantine` - standalone, no integration yet. No test suite. API is provisional.

## Source
`packages/tools/interval-tree.ts`

## Integration Path
1. **Scheduling** - use in `packages/orchestration/` worktree pool to detect overlapping task time windows before dispatch.
2. **Token span management** - use in `packages/memory/` to index episodic memory time ranges for fast range retrieval.
3. **Permission windows** - use in `packages/permissions/` for time-gated policy rules.
4. **AST index** - use in `packages/ast-index/` to map source character ranges to symbols.

## Promotion Criteria
- Unit test suite (insert/overlap/point/remove/edge cases)
- Benchmark vs naive linear scan at n=1000, n=10000
- One real consumer in the codebase using it
- No regressions in existing package tests
