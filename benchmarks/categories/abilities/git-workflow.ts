// -- Git Workflow Benchmark ------------------------------------------------------
// Tests: agent's ability to perform git operations correctly
// Validates branching, conventional commits, merge conflict resolution,
// and worktree isolation pattern adherence.

export const benchmark = {
  id: "AB008",
  name: "Git: Workflow Operations",
  ability: "git",
  difficulty: "hard" as const,

  prompt: `You are working in a test repository. Prove you can handle real-world
git workflows by completing ALL four tasks below. Use actual git commands and
show the output at each step.

--- Task 1: Branch, commit, and push ---
Create a feature branch called "feature/add-healthcheck" from main. On that
branch:
  1. Create a file \`src/healthcheck.ts\` that exports a function
     \`checkHealth(): { status: string; uptime: number }\` returning
     \`{ status: "ok", uptime: process.uptime() }\`.
  2. Stage and commit the file with a conventional commit message
     (type + scope + description, e.g. "feat(health): add healthcheck endpoint").
  3. Push the branch to origin.
Report the branch name, commit hash, and commit message.

--- Task 2: Conventional commit quality ---
Write 5 commit messages for the following changes (do NOT actually commit,
just output the messages):
  a. Fixed a null pointer crash in the auth middleware.
  b. Added unit tests for the payment service.
  c. Updated the README with API docs.
  d. Removed deprecated v1 routes.
  e. Refactored the database connection pool to use async/await.

Each message MUST follow Conventional Commits (type(scope): description).
Types: feat, fix, test, docs, refactor, chore. No em dashes. Under 72 chars.
Report all 5 messages clearly labeled a-e.

--- Task 3: Merge conflict resolution ---
Simulate and resolve a merge conflict:
  1. From main, create branch "conflict/left" and write a file
     \`src/config.ts\` exporting \`const PORT = 3000\`.
  2. From main, create branch "conflict/right" and write the same file
     \`src/config.ts\` exporting \`const PORT = 8080\`.
  3. Merge conflict/left into main.
  4. Attempt to merge conflict/right into main (this will conflict).
  5. Resolve the conflict by choosing port 8080 and keeping both branches'
     intent (add a comment explaining the override).
  6. Complete the merge commit.
Report the conflict markers you saw, your resolution, and the final file
contents.

--- Task 4: Worktree isolation ---
Demonstrate the worktree isolation pattern from packages/orchestration/:
  1. Explain why Eight uses worktrees instead of regular branches for
     parallel agent work.
  2. Show how to create a git worktree for an agent task:
     \`git worktree add .claude/worktrees/agent-<id> -b agent/<id>\`
  3. Explain what happens to uncommitted changes in the main worktree
     when an agent writes to its own worktree (answer: nothing, they
     are isolated filesystems).
  4. Show the cleanup command: \`git worktree remove\` + \`git worktree prune\`.
Report your explanation and the exact commands you would use.

Format your answers clearly with headers "TASK 1:", "TASK 2:", "TASK 3:",
"TASK 4:" so each section is identifiable.`,

  successCriteria: [
    "Task 1: feature branch created from main with correct name",
    "Task 1: healthcheck.ts exports checkHealth with correct signature",
    "Task 1: commit message follows conventional commits format",
    "Task 1: branch pushed to origin",
    "Task 2: all 5 messages use correct conventional commit types",
    "Task 2: all 5 messages have scope in parentheses",
    "Task 2: all 5 messages are under 72 characters",
    "Task 2: no em dashes in any message",
    "Task 3: conflict correctly simulated between two branches",
    "Task 3: conflict markers identified and shown",
    "Task 3: resolution picks port 8080 with explanatory comment",
    "Task 3: merge commit completed successfully",
    "Task 4: explains filesystem isolation benefit of worktrees",
    "Task 4: correct worktree add command with agent branch naming",
    "Task 4: confirms main worktree is unaffected by agent writes",
    "Task 4: shows cleanup with worktree remove and prune",
  ],

  scoring: [
    { metric: "branch_commit_push_correct", weight: 0.25 },
    { metric: "conventional_commits_quality", weight: 0.25 },
    { metric: "merge_conflict_resolution", weight: 0.30 },
    { metric: "worktree_isolation_understanding", weight: 0.20 },
  ],

  timeLimit: 180,
};

export default benchmark;
