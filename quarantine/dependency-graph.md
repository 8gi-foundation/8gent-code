# dependency-graph

## Tool name
`DependencyGraph`

## Description
Builds and queries directed module dependency graphs. Zero external dependencies - pure TypeScript data structure for static analysis, build-order resolution, and change impact detection inside the 8gent agent runtime.

**Capabilities:**
- Add/remove nodes (modules, packages, tasks) and directed edges
- Cycle detection - returns the exact cycle path via DFS coloring
- Topological sort (Kahn's algorithm) - dependency-first ordering, throws on cycles
- Direct dependencies and dependents for any node
- Transitive closure - all nodes reachable upstream or downstream
- Orphan detection - nodes with no edges (dead code candidates)

## Status
`quarantine`

## Integration path

**Target location:** `packages/tools/dependency-graph.ts` (already placed)

**Candidate consumers:**

| Consumer | Use case |
|----------|----------|
| `packages/ast-index/` | Build import dependency graph from parsed AST data |
| `packages/orchestration/` | Resolve task execution order before spawning worktrees |
| `packages/validation/` | Identify blast radius of a change before checkpoint-verify |
| `packages/eight/agent.ts` | Detect circular tool-call chains at planning time |

**Integration steps:**
1. Wire into `packages/ast-index/` - replace ad-hoc dependency tracking with `DependencyGraph`
2. Add `impactScore(id)` method weighted by transitive dependent count
3. Expose via agent tool registry so Eight can query "what breaks if I change X" at runtime

**Graduation criteria:**
- Consumed by at least one package with a measurable outcome (build-order test, cycle alert in CI)
- Cycle detection wired into pre-commit or harness validation
- No new external dependencies introduced
