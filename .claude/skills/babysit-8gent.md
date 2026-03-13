# Babysit 8gent — Iterative Testing & Bug-Fixing Feedback Loop

## Purpose
Run 8gent (our Claude Code alternative) with progressively harder test tasks, monitor session output, identify failures, fix the underlying 8gent code (system prompt, tools, agent loop), and repeat until 8gent successfully completes each task.

## Test Tasks (Progressive Difficulty)

### Level 1: Fibonacci (warm-up)
- **Task**: Create fib.js that prints first 20 Fibonacci numbers
- **Validates**: write_file + run_command
- **Pass**: file exists, output contains "4181"

### Level 2: Next.js Hello World (the real test)
- **Task**: Scaffold a Next.js project and make it display "Hello World"
- **Validates**: multi-step scaffolding, npm/bun commands, file creation, directory awareness, package.json creation, dev server
- **Pass**: `package.json` exists with `next` dependency, `app/page.tsx` (or `pages/index.tsx`) exists, page contains "Hello World", `bun install` succeeds, `next build` succeeds
- **This is the hard one.** It requires the agent to:
  1. Run `bun create next-app . --yes` OR manually scaffold files
  2. Modify the default page to say "Hello World"
  3. Install dependencies
  4. Verify the build works

### Level 3: (stretch) Add a route
- Add an `/about` page that says "About Page"

## Prerequisites
- OpenRouter API key set (OPENROUTER_API_KEY) or Ollama running
- Run `bun run harness:doctor` first to verify

## The Feedback Loop

### Phase 1: Health Check
```bash
bun run harness:doctor
```

### Phase 2: Clean Test Directory
```bash
rm -rf /tmp/8gent-test-nextjs && mkdir -p /tmp/8gent-test-nextjs
```

### Phase 3: Run 8gent
```bash
bun run harness:run \
  "Build a Next.js project in the current directory. Steps: 1) Create package.json with next, react, react-dom dependencies 2) Create app/layout.tsx with basic HTML layout 3) Create app/page.tsx that displays a heading saying Hello World 4) Create next.config.js 5) Create tsconfig.json 6) Run bun install to install dependencies 7) Run npx next build to verify it compiles" \
  --workdir /tmp/8gent-test-nextjs \
  --runtime openrouter \
  --model openai/gpt-4.1-mini \
  --max-steps 30 \
  --timeout 300000 \
  --json
```

### Phase 4: Inspect
```bash
bun run harness:inspect <sessionId>
```
Look for:
- Did it create files? Check tool_call entries for write_file
- Did it run commands? Check for run_command calls
- Did commands succeed? Check tool_result entries
- What errors occurred? Check tool_error and error entries
- Did it hit max steps? Check session_end exitReason

### Phase 5: Validate
```bash
# Check key files exist
bun run harness -- validate <sessionId> \
  --expect-file /tmp/8gent-test-nextjs/package.json \
  --json

# Manually verify
ls /tmp/8gent-test-nextjs/
cat /tmp/8gent-test-nextjs/app/page.tsx 2>/dev/null || cat /tmp/8gent-test-nextjs/pages/index.tsx 2>/dev/null
cat /tmp/8gent-test-nextjs/package.json
```

Then try building:
```bash
cd /tmp/8gent-test-nextjs && bun install && npx next build
```

### Phase 6: Diagnose & Fix 8gent Code

**Read the session carefully.** Common Next.js task failures and what to fix:

#### Problem: Agent doesn't know about Next.js app router structure
**Fix**: Update system prompt in `packages/eight/prompt.ts` to include Next.js scaffolding knowledge

#### Problem: `bun create next-app` hangs (interactive prompts)
**Fix**: Ensure system prompt tells agent to use `--yes` / `--no-input` flags, or to manually create files instead of using scaffolding CLIs

#### Problem: Agent creates files in wrong paths
**Fix**: The `write_file` tool in `packages/ai/tools.ts` — check how it resolves relative paths against `workingDirectory`

#### Problem: Agent calls tools with wrong argument names
**Fix**: The Zod schemas in `packages/ai/tools.ts` — the parameter names must match what the model expects from the system prompt tool docs

#### Problem: `run_command` fails with permission error
**Fix**: The harness already enables infinite mode. If still failing, check `packages/ai/tools.ts` run_command implementation

#### Problem: Agent tries tools that don't exist
**Fix**: The model is hallucinating tool names. The system prompt tool docs in `packages/eight/prompt.ts` must exactly match the tool names in `packages/ai/tools.ts`

#### Problem: Agent uses too many steps without progress
**Fix**: Improve system prompt to be more directive. Add "prefer manual file creation over CLI scaffolding" guidance

#### Problem: npm/bun install fails (network, missing packages)
**Fix**: Not an 8gent bug — environment issue. Verify manually first

### Phase 7: Apply Fix and Re-run
After making code changes, go back to Phase 2 (clean dir) and Phase 3 (re-run).

## Key Files to Modify

| File | What to fix |
|------|-------------|
| `packages/eight/prompt.ts` | System prompt — tool docs, scaffolding guidance, error recovery rules |
| `packages/ai/tools.ts` | Tool implementations — Zod schemas, argument handling, path resolution |
| `packages/ai/agent.ts` | Agent wrapper — maxSteps, callbacks, error handling |
| `packages/eight/agent.ts` | Agent class — session tracking, tool call wiring |
| `packages/ai/providers.ts` | Provider config — model parameters, API compatibility |
| `packages/permissions/index.ts` | Permission system — safe command patterns |
| `packages/harness-cli/commands/run.ts` | Harness runner — how the headless session is executed |

## Iteration Strategy

1. **Always start with a clean directory** — `rm -rf /tmp/8gent-test-nextjs && mkdir -p /tmp/8gent-test-nextjs`
2. **Read the full session after every run** — the JSONL is the source of truth
3. **Fix one thing at a time** — don't make 5 changes at once
4. **Re-run immediately after each fix** — verify before moving on
5. **Compare sessions** — use `bun run harness:sessions` to track progress across runs
6. **If the model is the bottleneck**, try `--model openai/gpt-4.1` (full size) or `--model anthropic/claude-sonnet-4`
7. **If the same error repeats 3 times**, the fix isn't working — try a different approach

## Success Criteria

The Next.js test passes when ALL of these are true:
1. `/tmp/8gent-test-nextjs/package.json` exists and contains `"next"` as a dependency
2. `/tmp/8gent-test-nextjs/app/page.tsx` (or `pages/index.tsx`) exists and contains "Hello World"
3. `/tmp/8gent-test-nextjs/app/layout.tsx` exists (for app router)
4. `bun install` in the test dir succeeds
5. `npx next build` in the test dir succeeds
6. The session completed without fatal errors
7. The session used fewer than 20 steps

## Escalation

If stuck after 5+ iterations:
- Read the raw JSONL: `cat ~/.8gent/sessions/<id>.jsonl | jq -r '.type'` to see the entry flow
- Try a stronger model: `--model anthropic/claude-sonnet-4`
- Simplify: break the task into "just create package.json" first, verify, then add complexity
- Check if tools are even being called: `bun run harness:inspect <id> --entries tool_call,tool_result,tool_error`
