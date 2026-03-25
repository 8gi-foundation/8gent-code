# Quarantine: task-dependency

## Summary

`DependencyResolver` - resolves task execution order from a dependency graph with cycle detection and parallel grouping.

## Location

`packages/tools/task-dependency.ts`

## API

### `addTask(name: string, deps?: string[]): this`

Register a task with optional dependencies. Chainable.

### `resolve(): string[]`

Returns tasks in a valid serial topological order. Throws if cycles are detected.

### `detectCycles(): string[][]`

DFS-based cycle detection. Returns an array of cycle paths (each as an array of task names). Returns empty array if the graph is acyclic.

### `getParallelGroups(): string[][]`

Groups tasks into parallel execution waves. Tasks within the same group have no dependencies on each other and can run concurrently. Each group must complete before the next begins.

## Usage

```ts
import { DependencyResolver } from "./packages/tools/task-dependency.ts";

const resolver = new DependencyResolver();

resolver
  .addTask("lint")
  .addTask("typecheck")
  .addTask("build", ["lint", "typecheck"])
  .addTask("test", ["build"])
  .addTask("deploy", ["test"]);

// Serial order
console.log(resolver.resolve());
// ["lint", "typecheck", "build", "test", "deploy"]

// Parallel groups
console.log(resolver.getParallelGroups());
// [["lint", "typecheck"], ["build"], ["test"], ["deploy"]]
```

## Cycle Detection

```ts
const r = new DependencyResolver();
r.addTask("a", ["b"]).addTask("b", ["a"]);
console.log(r.detectCycles()); // [["a", "b", "a"]]
```

## Size

- 130 lines
- Zero dependencies (stdlib only)

## Status

Quarantined - ready for integration into agent orchestration or worktree scheduling.
