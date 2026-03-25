# Quarantine: dep-graph

## What

`packages/tools/dep-graph.ts` - scans all `package.json` files across `apps/` and `packages/` workspace dirs, resolves internal cross-package dependencies, and outputs the graph in three formats:

- **Mermaid** (default) - paste into GitHub markdown or Mermaid Live Editor
- **Plain text** - human-readable list with arrows
- **JSON** - adjacency list for programmatic use

## Usage

```bash
bun run packages/tools/dep-graph.ts              # Mermaid diagram
bun run packages/tools/dep-graph.ts --format=text # Plain text
bun run packages/tools/dep-graph.ts --format=json # JSON adjacency list
```

## Current state

Most packages in this monorepo do not declare internal `@8gent/*` dependencies in their `package.json` - they use direct relative file imports instead. As a result, the package.json-based graph is sparse. The one declared internal edge today:

```
packages/control-plane -> packages/db
```

## Graduation criteria

- [ ] Confirm the tool is useful for CI or onboarding (e.g. visualizing the dep graph in PRs)
- [ ] Consider adding import-scan mode to catch undeclared file-level cross-package imports
- [ ] Wire into a CI step or `bun run` script if valuable

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/tools/dep-graph.ts` | 120 | Dependency graph generator |
| `quarantine/dep-graph.md` | this file | Quarantine doc |
