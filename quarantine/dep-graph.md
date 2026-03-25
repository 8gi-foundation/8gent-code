# Quarantine: dep-graph

**Status:** Review pending
**File:** `packages/tools/dep-graph.ts`

## What it does

Scans all `package.json` files in the monorepo, builds an internal dependency graph
of `@8gent/*` and `@podjamz/*` packages, detects cycles via DFS, and outputs
results as Graphviz DOT, JSON, or a human-readable summary.

## Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `buildGraph` | `(root?: string) => DepGraph` | Scans monorepo, returns `{ nodes, edges }` |
| `detectCycles` | `(graph: DepGraph) => Cycle[]` | DFS cycle detection, returns normalised cycle paths |
| `toDot` | `(graph: DepGraph, cycles?: Cycle[]) => string` | Graphviz DOT, cycle nodes/edges highlighted red |

## CLI usage

```bash
bun packages/tools/dep-graph.ts
bun packages/tools/dep-graph.ts --dot | dot -Tsvg > graph.svg
bun packages/tools/dep-graph.ts --cycles
bun packages/tools/dep-graph.ts --json
bun packages/tools/dep-graph.ts --root /path/to/monorepo --dot
```

## Zero dependencies

Uses only `fs` and `path` from Node/Bun built-ins.

## Design decisions

- Excluded dirs: `node_modules`, `.next`, `.git`, `dist`, `build`
- Internal dep filter: only `@8gent/*` and `@podjamz/*` scopes
- Cycle normalisation: rotate to lexicographically smallest start node
- DOT subgraphs: `cluster_apps` and `cluster_packages`
- Cycle highlighting: red fill on cycle nodes, bold red on cycle edges

## Current graph snapshot (2026-03-25)

- 23 packages/apps in the workspace
- 1 internal edge: `@8gent/control-plane` -> `@8gent/db`
- 0 cycles - valid DAG

## Review checklist

- [ ] Cycle detection handles diamond dependencies correctly
- [ ] DOT output renders with `dot -Tsvg`
- [ ] JSON output stable for downstream tooling
- [ ] Consider adding `bun packages/tools/dep-graph.ts --cycles` as CI gate
