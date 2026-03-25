# Quarantine: graph-builder

## What

Fluent API for building directed and undirected weighted graphs. Supports node and edge CRUD,
neighbor lookup, degree queries, and immutable `build()` output. Zero dependencies.

## File

`packages/tools/graph-builder.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { GraphBuilder } from "./packages/tools/graph-builder.ts";

// Directed graph
const g = GraphBuilder.directed()
  .addNode("a", { label: "Start" })
  .addNode("b")
  .addNode("c")
  .addEdge("a", "b", 1.0)
  .addEdge("b", "c", 2.5)
  .build();

g.neighbors("a"); // ["b"]
g.degree("b");    // 2

// Undirected graph
const u = GraphBuilder.undirected()
  .addNode("x")
  .addNode("y")
  .addEdge("x", "y", 0.5)
  .build();

u.neighbors("y"); // ["x"]

// Remove operations
const modified = GraphBuilder.directed()
  .addNode("1")
  .addNode("2")
  .addEdge("1", "2")
  .removeEdge("1", "2")
  .build();
```

## Graph interface

| Method | Returns | Description |
|--------|---------|-------------|
| `neighbors(id)` | `string[]` | Adjacent node IDs |
| `degree(id)` | `number` | Edge count for node |
| `.nodes` | `Map<string, NodeData>` | All nodes with metadata |
| `.edges` | `Edge[]` | All edges with weights |
| `.directed` | `boolean` | Graph type flag |

## Design notes

- `build()` returns an immutable snapshot. Mutations to the builder after `build()` do not affect prior snapshots.
- `addEdge()` auto-creates nodes if missing.
- `removeNode()` cascades and removes all connected edges.
- For undirected graphs, `neighbors()` checks both edge directions and `removeEdge()` removes both directions.
- Self-loops count twice toward `degree()` in undirected graphs (standard graph theory convention).
