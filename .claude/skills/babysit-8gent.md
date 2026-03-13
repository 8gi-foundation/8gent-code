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

### Level 3: REST API with Integration Tests — PASSES ✅
```bash
bun run harness run --task api
```
Validates: Hono CRUD routes, subprocess management, bun:test integration tests.
Passes in ~47s, 7 steps. Fixed by adding Hono serve patterns + bun:test toMatchObject bug knowledge to prompt.

### Level 4: Full-Stack Task Manager (6 files, 30 tests) — NEXT TARGET
```bash
bun run harness run --task fullstack
```
This is the next challenge. Requires:
1. In-memory database class (db.ts)
2. Validation module (validation.ts)
3. Hono REST API server (server.ts)
4. Unit tests for DB (db.test.ts) — 10 tests
5. Unit tests for validation (validation.test.ts) — 8 tests
6. Integration tests for API (api.test.ts) — 12 tests
7. ALL 30 tests must pass

## Fixes Applied So Far

| Fix | File | What was added |
|-----|------|----------------|
| Hono/Express/Bun serve patterns | `packages/eight/prompt.ts` | Common Framework Patterns section with exact code |
| bun:test toMatchObject mutation bug | `packages/eight/prompt.ts` | Warning that toMatchObject corrupts the actual object |
| Search-before-guess rule | `packages/eight/prompt.ts` | CRITICAL BEHAVIOR RULE #7 |
| Loop detection (runtime) | `packages/eight/agent.ts` | Fingerprints tool calls, injects warning after 3 repeated failures |
| Honest completion rule | `packages/eight/prompt.ts` | NEVER claim COMPLETED if tests fail |
| Anti-loop rule | `packages/eight/prompt.ts` | CRITICAL BEHAVIOR RULE #8 |

## The Feedback Loop

### Step 1: Run the failing task
```bash
bun run harness run --task fullstack
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
| Loops editing same file with wrong API | Missing framework knowledge | `packages/eight/prompt.ts` — add patterns |
| Never uses web_search to look up docs | No instinct to search | `packages/eight/prompt.ts` — search-before-guess rule |
| Tries same fix 5+ times | No loop detection | `packages/eight/agent.ts` — loop detection already added |
| Server starts but tests can't connect | Wrong port/host in test | Check the test file the agent wrote |
| Tests pass but agent doesn't notice | Output parsing issue | Check how agent reads run_command output |
| Agent says "COMPLETED" but tests failed | Success criteria too loose | `packages/eight/prompt.ts` — already tightened |
| toMatchObject corrupts test state | bun:test bug | Already documented in prompt — verify agent avoids it |

### Step 4: Fix 8gent code

Key files to modify:

| File | What to fix |
|------|-------------|
| `packages/eight/prompt.ts` | System prompt — framework knowledge, testing patterns, known bugs |
| `packages/ai/tools.ts` | Tool implementations — background_start, run_command |
| `packages/eight/agent.ts` | Agent class — loop detection, conversation management |
| `packages/permissions/index.ts` | Safe command patterns |
| `packages/harness-cli/commands/run.ts` | Task presets and validation |

### Step 5: Re-run and verify
```bash
bun run harness run --task fullstack
```

### Step 6: Iterate until it passes

## Session Files
Sessions are stored in `~/.8gent/sessions/` as JSONL files. Use the harness CLI to inspect:
```bash
bun run harness sessions              # list all
bun run harness inspect <id>          # full trace
bun run harness inspect <id> --summary # quick overview
```

## Success Criteria

Level 4 (fullstack) passes when:
1. All 6 files exist (db.ts, validation.ts, server.ts, db.test.ts, validation.test.ts, api.test.ts)
2. `bun test` runs and ALL 30 tests pass
3. Session uses fewer than 25 steps
4. No false completion claims

## Escalation

If stuck after 5+ iterations on the same root cause:
- Try a stronger model: `--model anthropic/claude-sonnet-4` or `--model openai/gpt-4.1`
- Check if the tool implementation is the bottleneck vs. the model's knowledge
- Simplify: break the task into sub-tasks
- Read the raw JSONL to see exactly what the model outputs between tool calls
