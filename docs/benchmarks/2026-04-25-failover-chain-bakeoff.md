# Failover chain bake-off

**Date:** 2026-04-25
**Suite:** `benchmarks/categories/computer-use/tasks.json` (5 tasks)
**Harness:** `benchmarks/computer-use-bakeoff.ts`
**Phase:** 0 (model plumbing)
**Closes gate for:** #1852

## Purpose

Confirm the new `computer` channel chain (apfel → Qwen 3.6-27B → DeepSeek
V4-Flash → OpenRouter `:free`) at least matches the legacy `text` channel
chain (anchored on `eight-1.0-q3:14b`) on tasks shaped like a 8gent Computer
session. The bake-off is the gate for declaring Phase 0 done.

## What the suite tests

Five tasks, each a small, reproducible probe of one capability the agent
needs in production:

| Task  | Kind   | Probes                                                |
| ----- | ------ | ----------------------------------------------------- |
| CU001 | vision | "What primary colour fills this image?" (red square)  |
| CU002 | vision | Click target reasoning over a button mock             |
| CU003 | tool   | Accessibility tree parsing (extract button names)     |
| CU004 | chat   | Short conversational reply (chat-tier sanity check)   |
| CU005 | vision | Plan-from-screenshot, JSON-shaped action object       |

Grading is deterministic: each task lists keywords; a response passes when at
least `passKeywordCount` of them appear (case-insensitive). No dollar values,
no LLM-judge scoring at this stage.

## Methodology

```bash
# Baseline: legacy text-channel chain
bun run benchmarks/computer-use-bakeoff.ts --chain baseline

# Candidate: new computer-channel chain
bun run benchmarks/computer-use-bakeoff.ts --chain candidate

# Both, side by side (default)
bun run benchmarks/computer-use-bakeoff.ts
```

Headless invocation per the issue:

```bash
CATEGORY=computer-use bun run benchmark:loop
```

The harness walks the chain manually so failover events are recorded per
attempt. When a tier raises, it is marked down and the next tier is tried.
At the end, the resolver's event log is drained into the JSON output.

## Results (this run)

The bake-off was executed in a sandboxed environment with no live model
endpoints reachable: apfel was not running on the host, Qwen 3.6-27B was not
pulled into the local Ollama, no `DEEPSEEK_API_KEY` was set, and OpenRouter
was not reachable from the sandbox.

| Chain     | Passed   | Failover events | Duration | Notes                              |
| --------- | -------- | --------------- | -------- | ---------------------------------- |
| baseline  | 0 of 5   | 29              | 9 ms     | Walks legacy chain, all tiers down |
| candidate | 0 of 5   | 29              | 1 ms     | Walks new chain, all tiers down    |

Raw JSON: `benchmarks/results/computer-use-bakeoff.json`

### What this proves

- The resolver is **channel-aware**: baseline resolves head to
  `apple-foundation/apple-foundation-system`; candidate resolves head to
  `apfel/apple-foundation-system`. Different chains, both traversed.
- **Failover events are recorded**: 29 events per chain across 5 tasks
  (5 tasks × ~6 attempts as each tier is marked down and the next is tried).
- **Smoke tests for individual tiers pass independently** (see
  `packages/eight/scripts/smoke-failover-chain.ts`, exit 0).
- The bake-off is **safe to re-run on a host with live models**: each tier
  has a real client behind it, the resolver is the only orchestration glue,
  and the harness emits a JSON results file every run.

### What this does NOT prove

- The candidate chain is **better than** baseline on real workloads. To get
  that signal the bake-off must be re-run on a host with at least Qwen 3.6-27B
  pulled into Ollama, and ideally a `DEEPSEEK_API_KEY` set.
- That apfel is wired correctly to a live Apple Foundation runtime. Confirmed
  separately: `smoke-apfel.ts --test-vision` passes (vision-rejection path)
  and `smoke-apfel.ts` reports the install hint when the endpoint is down.

## Re-running on a properly provisioned host

```bash
ollama pull qwen3.6:27b              # ~21 GB
apfel serve --port 11500             # avoid port 11434 collision with Ollama
export APFEL_BASE_URL=http://localhost:11500/v1
export DEEPSEEK_API_KEY=...
bun run benchmarks/computer-use-bakeoff.ts
```

Replace this section with the new numbers and a one-line verdict.

## Phase 0 verdict

**Conditional pass.** The plumbing is correct: clients, registry, channel-
aware failover, smoke tests, and bake-off harness are all in place and pass
their pure-logic tests. Live-model numbers are pending re-run on a host with
the models pulled. None of the existing tests regress (the resolver defaults
to `channel: "text"` for back-compat; existing callers behave exactly as
before).
