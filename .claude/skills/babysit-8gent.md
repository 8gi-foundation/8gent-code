# Babysit 8gent — End-to-End Integration Test Loop

## Purpose
Run 8gent through a real-world multi-turn conversation that exercises scaffolding, dev servers, file editing, and verification. Iterate on 8gent's code until it handles the full flow cleanly.

## The Test: Next.js Create → Start → Verify → Edit → Verify

Model: `z-ai/glm-5` via OpenRouter

### What 8gent must do (in a single conversation):
1. Create a Next.js project from scratch
2. Start the dev server (should auto-promote to background task)
3. The server should be accessible on a port
4. Change the homepage to say "Hello James"
5. The change should be in the correct file (`app/page.tsx` or equivalent)

### How to run it

**Option A: Use the harness CLI (headless, captures session)**
```bash
bun run harness run \
  --model z-ai/glm-5 \
  --max-steps 50 \
  --task nextjs-e2e
```
If the `nextjs-e2e` task preset doesn't exist yet, create it in `packages/harness-cli/commands/run.ts`.

**Option B: Manual multi-turn test via the TUI**
```bash
bun run tui
```
Then send these messages one at a time:
1. `create a nextjs project`
2. `start the dev server`
3. `change the homepage to say Hello James`
4. `verify the homepage says Hello James`

### How to create the harness task

Add to `TASK_PRESETS` in `packages/harness-cli/commands/run.ts`:

```typescript
"nextjs-e2e": {
  prompt: `Complete these tasks in order:
1) Create a new Next.js project using bun create next-app
2) Start the dev server using bun run dev (from inside the project directory)
3) Change the homepage (app/page.tsx or src/app/page.tsx) to display only: <h1>Hello James</h1>
4) Verify the file was written correctly by reading it back
5) Report the dev server URL and confirm the homepage was changed`,
  validate: "page.tsx",
},
```

## The Feedback Loop

### Step 1: Run the test
```bash
bun run harness run --task nextjs-e2e --model z-ai/glm-5
```

### Step 2: Inspect what happened
```bash
bun run harness sessions
bun run harness inspect <session-id> --summary
bun run harness inspect <session-id>
```

Or use the debugger: `http://localhost:3006?session=<session-id>`

### Step 3: Diagnose failures

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Agent can't find project files after scaffolding | Spatial awareness — not tracking subdirectory | Check `packages/eight/prompt.ts` spatial awareness rules |
| `bun run dev` hangs for 2 minutes | Auto-promote not working (10s timeout) | Check `packages/ai/tools.ts` runShellCommand |
| Agent writes homepage to wrong path | Not using `list_files` to orient | Prompt needs stronger orient-first rule |
| Agent loops trying different `bun run dev` flags | Not using `cd project && bun run dev` | May need prompt hint about `cd` for subdirectory commands |
| TUI stuck on "Thinking" after agent finishes | `isProcessing` not cleared | Check `apps/tui/src/app.tsx` promise handling |
| Agent claims COMPLETED but didn't verify | Honest completion rule not followed | Check prompt rule #9 |
| Agent guesses paths instead of listing | Model weakness, not using orient-first | Strengthen prompt or use stronger model |

### Step 4: Fix 8gent code

| File | What to fix |
|------|-------------|
| `packages/eight/prompt.ts` | System prompt — spatial awareness, orient-first, framework patterns |
| `packages/ai/tools.ts` | Tool implementations — run_command auto-promote, list_files |
| `packages/eight/agent.ts` | Agent class — event callbacks, loop detection |
| `apps/tui/src/app.tsx` | TUI — message streaming, non-blocking agent, process panel |
| `packages/harness-cli/commands/run.ts` | Task presets |

### Step 5: Re-run and compare
```bash
bun run harness run --task nextjs-e2e --model z-ai/glm-5
```

Compare sessions in the debugger. Did it get further? Use fewer steps? Avoid the previous failure?

## Success Criteria

The test passes when:
1. Next.js project is created successfully
2. Dev server starts and gets auto-promoted to background task
3. Agent reports the server URL (e.g., `http://localhost:3000`)
4. Homepage file is changed to show "Hello James"
5. Agent reads the file back to verify
6. Total session uses fewer than 20 steps
7. No false COMPLETED claims
8. TUI stays responsive throughout (input always visible)

## Model Notes

- `z-ai/glm-5` — test target model. If it struggles, compare with `openai/gpt-4.1-mini` to isolate model vs. tooling issues.
- `openai/gpt-4.1` — use as a reference for what good behavior looks like
- `anthropic/claude-sonnet-4` — another strong reference

## Fixes Applied So Far

| Fix | File | What was added |
|-----|------|----------------|
| Spatial awareness rules | `prompt.ts` | Orient first, track project root, orient on failure |
| Auto-promote long-running commands | `tools.ts` | 10s timeout → background task via adoptProcess() |
| Real-time tool streaming | `app.tsx` | onToolStart/onToolEnd events show in chat |
| Assistant text streaming | `app.tsx` | onStepFinish streams reasoning in real-time |
| Non-blocking agent | `app.tsx` | agent.chat() is fire-and-forget with message queue |
| Always-visible input | `command-input.tsx` | Processing status above input, not replacing it |
| Command failure visibility | `app.tsx` | Exit code errors shown inline |
| list_files shows directories | `tools.ts` | Removed nodir:true, shows trailing / |
| Process panel | `process-panel/` | Ctrl+B sidebar for background processes |
| Loop detection | `agent.ts` | Fingerprints tool calls, warns after 3 repeats |
| Native tool calling | `prompt.ts` | Removed JSON tool format, uses API function calling |
| Dev server prompt warning | `prompt.ts` | Don't use run_command for servers |
| Honest completion | `prompt.ts` | 🔴 INCOMPLETE if tests fail |
