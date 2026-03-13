# Babysit 8gent — Iterative Testing & Bug-Fixing Feedback Loop

## Purpose
Run 8gent (our Claude Code alternative) with a test task, monitor its session output, identify failures, fix the underlying code, and repeat until 8gent successfully completes the task.

The default test task is: **"Create a script that computes and prints the first 20 Fibonacci numbers"** — a simple, verifiable task that exercises file creation, code writing, and shell execution.

## Prerequisites
- A local LLM provider must be running (Ollama, LM Studio, or OpenRouter API key set)
- Run `bun run harness:doctor` first to verify

## The Feedback Loop

### Phase 1: Health Check
```bash
bun run harness:doctor
```
If Ollama/LM Studio aren't running, advise the user to start them. If no provider is available, abort.

### Phase 2: Create a Clean Test Directory
```bash
mkdir -p /tmp/8gent-test-fibonacci && cd /tmp/8gent-test-fibonacci
```
This isolates the test from the main repo.

### Phase 3: Run 8gent Headlessly
```bash
bun run harness:run "Create a file called fib.js that computes and prints the first 20 Fibonacci numbers. Use write_file to create fib.js, then run it with 'node fib.js' to verify it works." \
  --workdir /tmp/8gent-test-fibonacci \
  --timeout 120000 \
  --json
```
Capture the JSON output. Extract the `sessionId`.

### Phase 4: Inspect the Session
```bash
bun run harness:inspect <sessionId> --summary
```
Then read the full session if something looks wrong:
```bash
bun run harness:inspect <sessionId>
```

### Phase 5: Validate
```bash
bun run harness:validate <sessionId> --expect-file /tmp/8gent-test-fibonacci/fib.js --json
```

### Phase 6: Diagnose & Fix
Read the session output carefully. Common failure modes:

1. **Provider connection error** → The LLM isn't responding. Check `doctor` output.
2. **Tool execution error** → A tool threw an error. Read the `tool_error` entries.
   - Missing tool implementation → Fix in `packages/ai/tools.ts`
   - Wrong arguments → Fix the tool's Zod schema in `packages/ai/tools.ts`
   - Permission denied → Check `packages/permissions/`
3. **Agent produced no output** → The model returned empty text.
   - Check the system prompt in `packages/eight/prompt.ts`
   - Check the model config in `packages/ai/providers.ts`
4. **Agent didn't use tools** → Model isn't following tool format.
   - The system prompt needs clearer tool instructions
   - Or the AI SDK tool schemas aren't being passed correctly
   - Check `packages/ai/agent.ts` — the `createEightAgent` function
5. **Session writer crash** → Entries are malformed or missing.
   - Check `packages/specifications/session/writer.ts`
6. **Agent looped without progress** → Max steps hit without creating the file.
   - Check step_end entries for repeated tool calls
   - May need to improve the prompt or error recovery

After diagnosing, make the fix in the 8gent codebase, then go back to Phase 3.

### Phase 7: Verify Fix
Run the exact same test again. If it passes validation, the fix worked. If not, inspect the new session and iterate.

## Key Files to Know

| File | What it does |
|------|-------------|
| `packages/eight/agent.ts` | Agent class — orchestrates the agentic loop |
| `packages/eight/prompt.ts` | Default system prompt |
| `packages/ai/agent.ts` | AI SDK wrapper — `createEightAgent()` |
| `packages/ai/tools.ts` | All 38 tools as AI SDK `tool()` objects |
| `packages/ai/providers.ts` | Provider factory (Ollama, LM Studio, OpenRouter) |
| `packages/specifications/session/writer.ts` | Session JSONL writer |
| `packages/specifications/session/reader.ts` | Session reader + `normalizeToV1()` |
| `packages/permissions/` | Permission system |
| `packages/hooks/` | Lifecycle hooks |
| `packages/harness-cli/` | The harness CLI itself |

## Iteration Strategy

1. **Start simple**: Just try to run and see what happens
2. **Read the session**: The JSONL file is the source of truth
3. **Fix one thing at a time**: Don't try to fix everything at once
4. **Re-run after each fix**: Verify the fix before moving on
5. **Track progress**: Each session has a unique ID — you can compare runs

## Success Criteria
The task is "done" when:
- 8gent creates `/tmp/8gent-test-fibonacci/fib.js`
- The file contains valid JavaScript that prints Fibonacci numbers
- 8gent ran `node fib.js` and the output is correct
- The session completed without fatal errors

## Escalation
If after 5 iterations the same error persists:
- Check if the model itself is the problem (try a different model with `--model`)
- Check if the AI SDK version has breaking changes
- Read the raw session JSONL to see exactly what the model is outputting
- Consider simplifying the test task to isolate the issue
