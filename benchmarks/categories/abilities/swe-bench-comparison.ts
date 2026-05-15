// -- SWE-bench Comparison Benchmark -----------------------------------------------
// Tests the same patterns Cursor Composer 2 is benchmarked on:
// code planning, multi-file editing, terminal usage, long-horizon task execution.
// Inspired by SWE-bench, Terminal-Bench 2.0, and CursorBench evaluation axes.

export const benchmark = {
  id: "AB006",
  name: "SWE-bench Patterns: Plan, Edit, Execute",
  ability: "agentic-coding",
  difficulty: "hard" as const,

  prompt: `You are an autonomous coding agent. Complete all three phases below.
Output each phase clearly labeled: "Phase 1:", "Phase 2:", "Phase 3:".

--- Phase 1: Code Planning (tests long-horizon planning) ---

You are given a buggy Express.js middleware stack. The bug: authentication
middleware runs AFTER the rate-limiter, so unauthenticated requests still
consume rate-limit tokens, enabling a denial-of-service vector.

Current middleware order (server.ts):
  app.use(corsMiddleware);
  app.use(bodyParser.json());
  app.use(rateLimiter({ windowMs: 60000, max: 100 }));
  app.use(authMiddleware);
  app.use(routeHandler);

Write a step-by-step plan (numbered, max 6 steps) to fix this across multiple
files. Your plan must:
  - Identify which files need changes (at minimum: server.ts, auth.ts)
  - Explain the correct middleware ordering and why
  - Address that some routes (health check, public API) must skip auth
  - Describe how to verify the fix (what test would you write?)

--- Phase 2: Multi-File Edit (tests cross-file coherence) ---

Implement your plan. Produce the corrected code for these 3 files:

File 1 - server.ts: The fixed middleware stack with correct ordering.
File 2 - auth.ts: An authMiddleware that exports a skipPaths option,
  so health/public routes bypass auth. Must export the middleware factory.
File 3 - auth.test.ts: At least 3 test cases using a test framework of your
  choice that verify:
  (a) authenticated requests pass through
  (b) unauthenticated requests to protected routes get 401
  (c) unauthenticated requests to skipped paths (e.g. /health) pass through

--- Phase 3: Terminal Diagnosis (tests error interpretation) ---

Given this terminal output from a failing CI run:

\`\`\`
$ npm test
> jest --runInBand

FAIL src/auth.test.ts
  Auth Middleware
    x should reject unauthenticated requests (45ms)

    Expected: 401
    Received: 200

    at Object.<anonymous> (src/auth.test.ts:23:27)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
\`\`\`

Diagnose the root cause. Explain:
  1. What is the most likely reason the test receives 200 instead of 401?
  2. What specific line or configuration would you check first?
  3. Write the exact terminal commands (max 3) you would run to verify your
     hypothesis.`,

  successCriteria: [
    // Phase 1 - Planning
    "Plan identifies auth must run before rate-limiter or immediately after body parsing",
    "Plan mentions skip/exclude mechanism for public routes",
    "Plan includes a verification step (test or manual check)",
    "Plan covers at least server.ts and auth.ts",

    // Phase 2 - Multi-file edit
    "server.ts places authMiddleware before rateLimiter",
    "auth.ts exports a middleware factory with skipPaths configuration",
    "auth.test.ts has at least 3 test cases",
    "Test covers authenticated pass-through",
    "Test covers unauthenticated 401 rejection",
    "Test covers skip-path bypass",
    "All three files are syntactically valid TypeScript",

    // Phase 3 - Terminal diagnosis
    "Diagnosis identifies the route is likely in the skip list or auth is not applied",
    "Suggests checking middleware ordering or route path matching",
    "Provides concrete terminal commands to investigate",
  ],

  scoring: [
    { metric: "planning_quality", weight: 0.20 },
    { metric: "plan_identifies_correct_ordering", weight: 0.10 },
    { metric: "multi_file_edit_coherence", weight: 0.25 },
    { metric: "test_coverage_completeness", weight: 0.15 },
    { metric: "code_syntactically_valid", weight: 0.10 },
    { metric: "terminal_diagnosis_accuracy", weight: 0.15 },
    { metric: "terminal_commands_actionable", weight: 0.05 },
  ],

  timeLimit: 180,
};

export default benchmark;
