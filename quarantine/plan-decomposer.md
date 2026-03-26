# plan-decomposer

Decomposes a high-level goal into a tree of subtasks with dependencies and effort estimates.

## Requirements
- decompose(goal, maxDepth): returns task tree with parent-child relationships
- addTask(tree, parentId, { title, effort, dependencies[] })
- criticalPath(tree): returns the longest dependency chain
- totalEffort(tree): sums leaf task efforts
- renderTree(tree): ASCII task tree with effort estimates

## Status

Quarantine - pending review.

## Location

`packages/tools/plan-decomposer.ts`
