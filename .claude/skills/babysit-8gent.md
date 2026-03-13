# Babysit 8gent — Iterative Testing & Bug-Fixing Feedback Loop

## Purpose
Run 8gent (our Claude Code alternative) with progressively harder test tasks, monitor session output, identify failures, fix the underlying 8gent code (system prompt, tools, agent loop), and repeat until 8gent successfully completes each task.

## Test Tasks (Progressive Difficulty)

### Level 1: Fibonacci (warm-up) — PASSES
```bash
bun run harness run --task fib
```
Validates: write_file + run_command. Always passes. ~7s.

### Level 2: Next.js Hello World — PASSES
```bash
bun run harness run --task nextjs
```
Validates: multi-file scaffolding, bun install, next build. Passes. ~100s.

### Level 3: REST API with Integration Tests — FAILS
```bash
bun run harness run --task api
```
This is the one 8gent **cannot do yet**. It requires:
1. Create a Hono REST API server with CRUD routes
2. Create integration tests that hit the running server via fetch
3. Start the server in the background
4. Run tests against it
5. Debug failures and iterate until tests pass

**Why it fails**: 8gent doesn't know the correct Hono `serve()` API. It tries
`app.fire()`, `app.listen()`, `app.fire({ port: 3456 })` — none work. It burns
all 30 steps trying different server start methods and never gets the tests to pass.
270K tokens wasted in a debug loop that goes nowhere.

**Root causes to fix in 8gent**:
1. System prompt has no knowledge of Hono, Express, or web framework APIs
2. Agent has no web_search/web_fetch instinct — it guesses instead of looking up docs
3. No loop detection — agent doesn't realize it's tried the same fix 5 times
4. No "give up and try a different approach" heuristic

## The Feedback Loop

### Step 1: Run the failing task
```bash
bun run harness run --task api
```

### Step 2: Inspect what went wrong
```bash
bun run harness inspect <session-id>
bun run harness inspect <session-id> --summary
```

Look at:
- Which step did it get stuck on?
- What tool_result errors appeared?
- Did it loop on the same edit_file call?
- Did the server ever actually start?
- Did tests ever run? What was the failure output?

### Step 3: Diagnose the root cause

Read the session entries. The failure pattern will be one of:

| Pattern | Root cause | Fix location |
|---------|-----------|--------------|
| Loops editing same file with wrong API | Missing framework knowledge | `packages/eight/prompt.ts` — add Hono/Express serve patterns |
| Never uses web_search to look up docs | No instinct to search | `packages/eight/prompt.ts` — add "if unsure about an API, use web_search" |
| Tries same fix 5+ times | No loop detection | `packages/eight/agent.ts` or `packages/ai/agent.ts` — detect repeated tool calls |
| Server starts but tests can't connect | Wrong port/host in test | Check the test file the agent wrote |
| background_start doesn't work | Tool implementation bug | `packages/ai/tools.ts` — background_start tool |
| Tests pass but agent doesn't notice | Output parsing issue | Check how agent reads run_command output |
| Agent says "COMPLETED" but tests failed | Success criteria too loose | `packages/eight/prompt.ts` — tighten completion rules |

### Step 4: Fix 8gent code

**Most likely fixes needed (in order of impact):**

#### Fix 1: Add framework knowledge to system prompt
Edit `packages/eight/prompt.ts` to include:
```
## Common Framework Patterns
When creating web servers:
- Hono: import { Hono } from 'hono'; import { serve } from '@hono/node-server';
  const app = new Hono(); serve({ fetch: app.fetch, port: 3000 });
  OR for Bun: export default { fetch: app.fetch, port: 3000 };
- Express: app.listen(3000);
```

#### Fix 2: Add "search before guessing" rule
Add to system prompt:
```
## CRITICAL: When you don't know an API
If you are unsure about the correct API for a library, framework, or tool:
1. FIRST use web_search to look up the official documentation
2. NEVER guess function signatures — look them up
3. If web_search fails, try the most common/standard approach first
```

#### Fix 3: Add loop detection
In `packages/eight/agent.ts` or `packages/ai/agent.ts`, detect when the agent
makes the same edit_file call 3+ times and inject a message like:
"You have tried this approach 3 times without success. Try a completely different strategy."

### Step 5: Re-run and verify
```bash
bun run harness run --task api
```
Compare the new session to the old one. Did it get further? Did it fix the server start? Did tests pass?

### Step 6: Iterate
Keep going until `--task api` passes. Then make the task even harder.

## Key Files to Modify

| File | What to fix |
|------|-------------|
| `packages/eight/prompt.ts` | System prompt — add framework knowledge, search-before-guess rule |
| `packages/ai/tools.ts` | Tool implementations — background_start, run_command |
| `packages/ai/agent.ts` | Agent wrapper — loop detection, step callbacks |
| `packages/eight/agent.ts` | Agent class — conversation history, error handling |
| `packages/permissions/index.ts` | Safe command patterns |
| `packages/harness-cli/commands/run.ts` | Task presets and validation |

## Success Criteria

Level 3 (api) passes when:
1. server.ts exists with working Hono CRUD routes
2. api.test.ts exists with tests for all 4 endpoints
3. The server starts successfully in the background
4. `bun test` runs and ALL tests pass
5. The session uses fewer than 20 steps (efficiency)
6. Token usage under 100K (no debug loops)

## Escalation

If stuck after 5+ iterations on the same root cause:
- Try a stronger model: `--model anthropic/claude-sonnet-4` or `--model openai/gpt-4.1`
- Check if the tool implementation is the bottleneck vs. the model's knowledge
- Simplify: break the API task into sub-tasks (just "start a Hono server on port 3456")
- Read the raw JSONL to see exactly what the model outputs between tool calls
