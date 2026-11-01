# Day-3 Judge-vs-Proxy Agreement — 2026-05-16

## Verdict

**INCONCLUSIVE - proxy rater not available, no trajectory data to sample.**

Two independent blockers stopped the agreement computation:

1. **No frontier-model API key** in env (`ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` both unset).
2. **No trajectory data** to sample. The local 27B executor stalled mid-task on the smoke run, so `eval/results/2026-05-16-day3-run.jsonl` contains no completed turn-level verdicts. With zero verdicts in the pool, the 30-verdict sample cannot be drawn.

Per the boardroom kill-gate (8EO, 2026-05-16): inconclusive is treated the same as < 70% agreement. Recommendation: ship behind `/go --experimental` flag.

## Honest caveat

The "human" rater for this gate was specified as a frontier-model proxy (Claude Sonnet 4.6 via Anthropic API, or via OpenRouter). The proxy is unavailable in this environment.

A local fallback (`apple-foundationmodel` via apfel at localhost:11435) is wired into the script and can be activated with `PROXY_ALLOW_LOCAL=1`, but using it would mark the entire report as DEGRADED because:
- Same-machine bias risk (judge + proxy + executor all on James's Mac).
- Small foundation model (~3B params) is not a substitute for a frontier-class rater.

The right move is to re-run with a real frontier proxy, not to ship a degraded local-only number as the gate verdict.

## What the script will do once API access is restored

`scripts/judge-vs-proxy-rater.ts`:
1. Loads `eval/results/2026-05-16-day3-run.jsonl`.
2. Builds the pool of turn-level verdicts across all completed tasks.
3. Samples 30 verdicts with deterministic seed `0x8C1` (reproducible).
4. For each sample, sends the goal + turn summary to the frontier proxy with prompt:
   `{"achieved": true|false, "reasoning": "..."}`.
5. Compares proxy `achieved` to FailoverJudge `decision === "satisfied"`.
6. Computes agreement % and per-task breakdown.
7. Emits 5 sample trajectories for James to spot-check the proxy's calibration.
8. Writes verdict line at the top: PASS (>= 70%) or FAIL (< 70%).

## Remediation

```bash
# Pick one:
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
export PROXY_ALLOW_LOCAL=1   # degraded local fallback, not recommended for ship gate

# Also re-run the sweep so we have trajectory data:
bash scripts/setup-eval-fixtures.sh
bun scripts/run-eval-set.ts                # populates the JSONL
bun scripts/judge-vs-proxy-rater.ts        # then this can read it
```
