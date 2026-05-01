// -- Worktree Delegation Benchmark ------------------------------------------------
// Tests: packages/orchestration/ (WorktreePool, WorktreeMessaging)
// Validates subagent spawning, filesystem messaging, result merging,
// and the max-4 concurrency limit.

export const benchmark = {
  id: "AB006",
  name: "Worktree: Delegation and Messaging",
  ability: "worktree",
  difficulty: "hard" as const,

  prompt: `You are an orchestrator agent. Prove that Eight's worktree delegation
system works end-to-end by completing ALL four tasks below.

--- Task 1: Spawn a subagent ---
Using WorktreePool from packages/orchestration/worktree-pool.ts, spawn a
subagent with the prompt "Create a file called HELLO.md containing 'Hello
from subagent'". Report the task ID, branch name, and worktree path that
were returned. Show that the task status transitions from "pending" to
"running".

--- Task 2: Filesystem messaging ---
Using WorktreeMessaging from packages/orchestration/worktree-messaging.ts,
demonstrate agent-to-agent communication:
  1. Create a messaging instance.
  2. Send a message from "orchestrator" to "worker-1" with type "task"
     and content "Summarize the README".
  3. Send a second message from "orchestrator" to "worker-1" with type
     "notification" and content "Priority: high".
  4. Peek at worker-1's inbox and confirm both messages are present.
  5. Consume worker-1's inbox and confirm it is now empty.
Report each message ID and the peek/consume results.

--- Task 3: Merge results from multiple agents ---
Spawn 3 subagents simultaneously (not sequentially). Each writes a
different file:
  - Agent A: writes packages/tmp/a.ts exporting \`const A = "alpha"\`
  - Agent B: writes packages/tmp/b.ts exporting \`const B = "beta"\`
  - Agent C: writes packages/tmp/c.ts exporting \`const C = "gamma"\`
Call collectAll() to gather all results. Then create packages/tmp/index.ts
that barrel-exports A, B, and C. Report the result status of each task.

--- Task 4: Concurrency limit enforcement ---
Attempt to spawn 6 tasks at once on a WorktreePool configured with
maxConcurrent: 4. Show that:
  - At most 4 tasks have status "running" at any point.
  - The remaining tasks stay "pending" until a slot opens.
  - All 6 eventually complete.
Report the status snapshot immediately after spawning and after all complete.

Format your answers clearly with headers "TASK 1:", "TASK 2:", "TASK 3:",
"TASK 4:" so each section is identifiable.`,

  successCriteria: [
    "Task 1: subagent spawned with valid task ID, branch, and worktree path",
    "Task 1: status shown transitioning from pending to running",
    "Task 2: two messages sent from orchestrator to worker-1",
    "Task 2: peek returns both messages without removing them",
    "Task 2: consume returns messages and inbox is empty afterward",
    "Task 3: three subagents spawned simultaneously, not sequentially",
    "Task 3: collectAll gathers results from all three",
    "Task 3: barrel-export index.ts created with all three exports",
    "Task 4: max 4 tasks running concurrently despite 6 spawned",
    "Task 4: remaining tasks queued as pending",
    "Task 4: all 6 tasks eventually complete",
  ],

  scoring: [
    { metric: "subagent_spawn_correct", weight: 0.15 },
    { metric: "messaging_send_peek_consume", weight: 0.25 },
    { metric: "parallel_spawn_and_merge", weight: 0.30 },
    { metric: "concurrency_limit_enforced", weight: 0.30 },
  ],

  timeLimit: 300,
};

export default benchmark;
