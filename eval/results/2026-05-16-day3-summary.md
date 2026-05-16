# Day-3 Eval Gate Summary — 2026-05-16

## Verdict

**FAIL - ship behind `/go --experimental` flag.**

The Day-3 judge-vs-human-proxy agreement gate **could not be completed in this session**. Per the boardroom kill-gate criterion (agreement < 70% OR inconclusive), the safe default is: ship Friday 2026-05-22 behind an `--experimental` flag, reframe as "early access", do not lead the launch narrative.

This is the conservative call because the data we DO have shows the local stack is too slow to produce 30 turn-level verdicts within a 90-minute window, and we have no frontier-model proxy rater configured.

## Why the gate is inconclusive

Three independent constraints stacked:

1. **No frontier-model API key in env.** Neither `ANTHROPIC_API_KEY` nor `OPENROUTER_API_KEY` is set on this machine. `~/.8gent/keys.env` has the placeholder lines but no values. The Day-3 spec calls for a frontier-model proxy (Claude Sonnet 4.6) to stand in for James as the rater on 30 sampled trajectories. Without the key, the proxy script `scripts/judge-vs-proxy-rater.ts` exits with a remediation message and writes the partial-result report.

2. **Local 27B executor is too slow for a 20-task sweep inside 90 min.** Smoke test (`scripts/demo-go-e2e.ts`) on the trivial "create a file with content `works`" task completed end-to-end in ~3 min. The simplest fixture-dependent task (`go-003`, dedupe-by-hash) ran 3 internal agent steps in ~1m45s and then stalled (bun process went to 0% CPU after step 3, no further events). Even if every task converged in 3-5 min, 14 runnable tasks would consume 42-70 min — close to the cap with zero margin.

3. **12 of 20 tasks need fixtures that don't ship in the eval directory.** The eval README references `~/8gent-code-go-evals/eval/setup-fixtures.sh` but that script does not exist in this branch. I synthesised a minimal fixture set (`scripts/setup-eval-fixtures.sh`) to unblock the run, but the synthetic data may not match what the original task author intended. Results from fixture-dependent tasks should be treated as indicative, not authoritative.

## What this PR ships

| Deliverable | File | Status |
|-------------|------|--------|
| Runner script (loads tasks, runs GoalLoop + EightExecutor + FailoverJudge, runs verification) | `scripts/run-eval-set.ts` | Ready |
| Proxy-rater script (samples 30 verdicts at seed 0x8C1, calls Anthropic/OpenRouter/apfel, computes agreement) | `scripts/judge-vs-proxy-rater.ts` | Ready, BLOCKED on API key |
| Minimal fixture synthesizer (idempotent, creates 12 fixture files for fixture-dependent tasks) | `scripts/setup-eval-fixtures.sh` | Ready |
| This summary | `eval/results/2026-05-16-day3-summary.md` | This file |
| Agreement report (partial) | `eval/results/2026-05-16-day3-agreement.md` | Inconclusive (no API key) |

## Per-task results

No tasks completed full goal-loop convergence in this session. The breakdown of what would have happened:

| Task | Category | Difficulty | Plan |
|------|----------|------------|------|
| go-001 | filesystem | medium | SKIP - touches ~/Downloads (destructive on real user data) |
| go-002 | filesystem | easy | SKIP - touches ~/Documents (destructive on real user data) |
| go-003 | filesystem | medium | RUN - fixture (synthesised). Hung after 3 internal steps in single-task test. |
| go-004 | filesystem | easy | RUN - fixture (synthesised) |
| go-005 | filesystem | medium | SKIP - touches ~/8gent-code-go-evals (destructive on real repo state) |
| go-006 | filesystem | easy | SKIP - touches ~/Desktop, ~/Pictures (destructive) |
| go-007 | code-edit | easy | RUN - fixture (synthesised) |
| go-008 | code-edit | medium | RUN - fixture (synthesised) |
| go-009 | code-edit | easy | RUN - fixture (synthesised) |
| go-010 | code-edit | hard | RUN - fixture (synthesised) |
| go-011 | research | easy | RUN - safe (writes to /tmp, web search) |
| go-012 | research | easy | RUN - fixture (synthesised) |
| go-013 | research | hard | RUN - safe (writes to /tmp, web search) |
| go-014 | data-cleanup | easy | RUN - fixture (synthesised) |
| go-015 | data-cleanup | medium | RUN - fixture (synthesised) |
| go-016 | data-cleanup | medium | RUN - fixture (synthesised) |
| go-017 | data-cleanup | hard | RUN - fixture (synthesised) |
| go-018 | comms-draft | medium | RUN - fixture (synthesised) |
| go-019 | comms-draft | medium | RUN - fixture (synthesised) |
| go-020 | comms-draft | hard | SKIP - touches ~/8gent-code-go-evals (destructive) |

5 tasks skipped for destructive-real-userdir safety. 13 would have run against synthesised fixtures.

## Skipped tasks

- **go-001, go-002, go-005, go-006, go-020**: touch user-owned directories (`~/Downloads`, `~/Documents`, `~/Desktop`, `~/Pictures`, `~/8gent-code-go-evals`). Running an autonomous goal-loop against real user data with `Delete`/`Move` permissions is irreversible and not the scope of a judge-eval gate. The runner skips these with a clear reason. If you want them in the eval, sandbox the agent against a `TMPDIR`-relocated `$HOME` first.

## Errors / blockers

1. **No frontier-model API key.** Set one of:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   export OPENROUTER_API_KEY=sk-or-...
   export PROXY_ALLOW_LOCAL=1   # degraded local fallback via apfel
   ```
2. **27B local executor wall-clock.** The 90-min sweep budget cannot accommodate the 27B model in its current state. A faster local model (`qwen3:14b` or similar) is required, OR the eval needs to be reframed as "12-hour overnight sweep" not "90-min synchronous gate".
3. **Fixture setup script missing from the canonical path.** The eval README points to `~/8gent-code-go-evals/eval/setup-fixtures.sh`; this branch ships `scripts/setup-eval-fixtures.sh` as a minimal stand-in. Reconcile before Friday.

## Cost

- **Wall-clock:** ~95 min total spent on this session (most of it waiting on the local model).
- **Tokens:** ~0 frontier (no API key in use), executor token usage was logged by the agent but never reached the receipt because no task completed.
- **Cloud cost:** $0.

## Recommendation

1. **Ship Friday behind `/go --experimental`.** Front-page launch is off the table because we cannot prove judge-vs-human agreement >= 70% with the current local-only stack in a synchronous gate window.
2. **Re-run the gate overnight Sun 2026-05-17 or Mon 2026-05-18 with:**
   - At least one of `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` in env.
   - Either a faster executor model pulled (`qwen3:14b`) OR an extended 6-12 hour wall-clock budget.
   - Real fixtures from the task authors (not the synthesised set in this PR).
3. **If the re-run lands agreement >= 70%, flip `/go --experimental` to `/go` on the homepage Mon evening.** If still below 70%, hold the front-page launch entirely and use the experimental flag to gather week-1 telemetry against the real eval.

## How to re-run

```bash
# 1. Synthesise fixtures (or replace with the canonical set when it lands)
bash scripts/setup-eval-fixtures.sh

# 2. Run the eval sweep (writes eval/results/<date>-day3-run.jsonl)
bun scripts/run-eval-set.ts

# 3. Run the proxy-rater (requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY)
export OPENROUTER_API_KEY=sk-or-...
bun scripts/judge-vs-proxy-rater.ts

# 4. Read eval/results/<date>-day3-agreement.md for the verdict
```
