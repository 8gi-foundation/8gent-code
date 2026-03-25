# Quarantine: dep-graph

**Status:** Review pending
**File:** `packages/tools/dep-graph.ts`

## What it does

Scans all `package.json` files in the monorepo, builds an internal dependency graph
of `@8gent/*` and `@podjamz/*` packages, detects cycles via DFS, and can output
results as Graphviz DOT, JSON, or a human-readable summary.

## Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `buildGraph` | `(root?: string) => DepGraph` | Scans monorepo and returns `{ nodes, edges }` |
| `detectCycles` | `(graph: DepGraph) => Cycle[]` | DFS cycle detection, returns normalised cycle paths |
| `toDot` | `(graph: DepGraph, cycles?: Cycle[]) => string` | Renders DOT format, highlights cycles in red |

## CLI usage

```bash
# Human-readable summary
bun packages/tools/dep-graph.ts

# Graphviz DOT (pipe to dot -Tsvg)
bun packages/tools/dep-graph.ts --dot

# CI gate - exits 1 if any cycles found
bun packages/tools/dep-graph.ts --cycles

# JSON for tooling
bun packages/tools/dep-graph.ts --json

# Custom root
bun packages/tools/dep-graph.ts --root /path/to/monorepo --dot
```

## Zero dependencies

Uses only Node/Bun built-ins (`fs`, `path`). No npm deps.

## Design decisions

- **Excluded dirs:** `node_modules`, `.next`, `.git`, `dist`, `build` - avoids scanning build artifacts
- **Internal dep filter:** only `@8gent/*` and `@podjamz/*` scopes are treated as internal
- **Cycle normalisation:** cycles are deduplicated and canonicalised (start from lexicographically smallest node)
- **DOT subgraphs:** packages grouped into `cluster_apps` and `cluster_packages` for readability
- **Cycle highlighting:** DOT output marks cycle nodes (red fill) and cycle edges (red, bold)

## Current graph snapshot (as of 2026-03-25)

Running `bun packages/tools/dep-graph.ts` against the repo shows:

- 22 named packages/apps
- 1 internal edge: `@8gent/control-plane` -> `@8gent/db`
- 0 cycles detected

The graph is currently a DAG. The `--cycles` flag can be added to CI to enforce this.

## Review checklist

- [ ] Cycle detection handles diamond dependencies correctly (it does - DFS with in-stack tracking)
- [ ] Performance acceptable for large monorepos (linear scan, no re-reads)
- [ ] DOT output renders correctly with `dot -Tsvg`
- [ ] JSON output format stable enough to wire into other tooling
- [ ] Consider adding to CI as `bun packages/tools/dep-graph.ts --cycles` gate
