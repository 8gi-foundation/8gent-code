# Quarantine: tree-printer

## What

Self-contained tree structure printer that renders any tree data structure as indented text with branch connectors. Supports Unicode box-drawing characters (`├──`, `└──`, `│`) and ASCII fallback (`|--`, `` `-- ``, `|`). Handles async child resolvers, configurable depth limits, and multi-root forests.

## File

`packages/tools/tree-printer.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { printTree, printForest } from './packages/tools/tree-printer.ts';

// Single tree
const output = await printTree(
  rootNode,
  (node) => node.children ?? [],   // sync or async
  (node) => node.name,
  { style: 'unicode', maxDepth: 5 }
);

// Forest (multiple roots)
const forest = await printForest(
  [nodeA, nodeB],
  (node) => node.children ?? [],
  (node) => node.label,
  { style: 'ascii' }
);
```

## Example output

```
root
├── src
│   ├── index.ts
│   ├── utils.ts
│   └── components
│       ├── Button.tsx
│       └── Input.tsx
├── package.json
└── tsconfig.json
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `style` | `"unicode" \| "ascii"` | `"unicode"` | Connector character set |
| `maxDepth` | `number` | `Infinity` | Maximum depth to traverse |

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: fixture trees with expected string output
- [ ] Wire into TUI for displaying memory graph, worktree pool, or AST hierarchy
- [ ] Consider `--tree` flag on relevant CLI commands (e.g. `8gent memory`, `8gent worktree`)
