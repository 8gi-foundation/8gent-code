# priority-queue

## Tool Name
PriorityQueue<T>

## Description
Generic binary heap priority queue with configurable comparator. Supports min-heap, max-heap, or any custom ordering via a user-supplied comparator. Provides O(log n) push/poll, O(1) peek, and a pushPoll fast-path for bounded-size queues.

Key operations:
- push(item) - enqueue with automatic heap ordering
- poll() - dequeue highest-priority item
- peek() - inspect without removing
- pushPoll(item) - atomic push + poll (useful for bounded queues)
- drain() - ordered flush of all elements
- size / isEmpty() - state inspection

## Status
quarantine - implementation complete, not yet wired into any consumer.

## Integration Path
1. Agent task scheduler - packages/eight/agent.ts can replace its internal task array with PriorityQueue<Task> ordered by task.priority to ensure high-priority tool calls preempt lower-priority background work.
2. Orchestration worktree pool - packages/orchestration/ can use a max-heap to schedule which worktree job runs next based on urgency score.
3. Proactive opportunity pipeline - packages/proactive/ bounty scanner can maintain a live ranked queue of opportunities ordered by estimated value.

## File
packages/tools/priority-queue.ts
