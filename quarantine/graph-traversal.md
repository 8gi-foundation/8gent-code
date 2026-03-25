# graph-traversal

**Tool name:** graph-traversal
**File:** `packages/tools/graph-traversal.ts`
**Status:** quarantine
**Lines:** ~140

## Description

Generic `Graph<T>` class for agent planning, dependency resolution, and task scheduling. Supports directed and undirected graphs with weighted edges.

Algorithms included:

- **BFS** - breadth-first traversal from a start node
- **DFS** - depth-first traversal from a start node
- **Dijkstra** - shortest path between any two nodes, with full path reconstruction
- **Connected components** - groups of reachable nodes
- **Cycle detection** - DFS coloring, works for both directed and undirected graphs

## Usage

```typescript
import { Graph } from '../packages/tools/graph-traversal';

const g = new Graph<string>(false); // undirected
g.addEdge('A', 'B', 1);
g.addEdge('B', 'C', 4);
g.addEdge('A', 'C', 7);

console.log(g.bfs('A'));               // ['A', 'B', 'C']
console.log(g.shortestPath('A', 'C')); // { path: ['A', 'B', 'C'], cost: 5 }
console.log(g.hasCycle());             // false
```

## Integration path

1. **Agent planning** - wire into `packages/orchestration/` to model task dependency graphs and find optimal execution order via Dijkstra.
2. **Memory graph** - use as backend for relational memory queries in `packages/memory/`.
3. **Capability matching** - model agent capabilities as nodes, use BFS to find reachable skills from a given starting capability.
4. **Tool gate:** promote out of quarantine once integrated with one of the above and covered by a unit test.
