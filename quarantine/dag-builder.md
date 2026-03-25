# dag-builder

Build and traverse directed acyclic graphs.

## Requirements
- addNode(id, data), addEdge(from, to)
- dependsOn(id) -> string[] direct dependencies
- dependedOnBy(id) -> string[] reverse dependencies
- executionOrder() -> string[][] batches of parallel groups
- Cycle detection on addEdge

## Status

Quarantine - pending review.

## Location

`packages/tools/dag-builder.ts`
