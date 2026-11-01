# /goal Eval Set

Status: v1 (locked 2026-05-16)
Owner: 8PO (Samantha)
Source of truth: `go-task-set-v1.jsonl`
Cross-reference: epic #2605, sub-issue #2607, boardroom minutes `2026-05-16-go-feature.md`

The eval set is the only thing that decides whether `/goal` shipped a working product on Friday 2026-05-22. Twenty tasks. Deterministic verification. No "looks right" judgments.

---

## Why this exists

The /goal loop's success metric is local-only completion rate >= 60% on a fixed task set, measured week 1 post-ship. The kill criterion is judge-vs-human agreement >= 70% on day 3 (30 sampled trajectories from this set). Without a locked set, both metrics are meaningless.

The set is also our defense against scope creep. If a feature proposal during week 1 doesn't move a number on this set, it doesn't ship.

---

## Coverage

Twenty tasks, balanced across:

| Category     | Count | Why                                                          |
| ------------ | ----- | ------------------------------------------------------------ |
| filesystem   | 6     | Most common real chore. Includes the launch demo (go-001).   |
| code-edit    | 4     | TDD + refactor + bugfix + validation. Daily-work shape.      |
| research     | 3     | Forces web/local-doc mix. Tests citation discipline.         |
| data-cleanup | 4     | CSV, JSONL, log scrub, merge. Privacy-sensitive defaults.    |
| comms-draft  | 3     | Email, PR description, changelog. Tone + style adherence.    |

Difficulty split: 8 easy / 8 medium / 4 hard.

Local-only target: 15 tasks must converge on Apple Foundation / Ollama / LM Studio without cloud fallback. 5 tasks allow cloud (research + complex reasoning).

Walk-away tasks (>5 min wall-clock): 6. These stress the loop's ability to run unattended.

---

## How to run the eval

### Prerequisites

```bash
# Fixtures must exist before any run
~/8gent-code-go-evals/eval/setup-fixtures.sh   # creates /tmp/eval-fixtures/

# Active provider must be local (default: 8gent / eight-1.0-q3:14b)
# Cloud-allowed tasks use the failover chain
```

### Single task

```bash
bun run eval:go --task go-001
```

This invokes the daemon with the task's goal, lets `/goal` run to terminal state or budget exhaustion, then runs the task's `verification.check` command. Pass/fail is binary.

### Full sweep

```bash
bun run eval:go --all --output ~/.8gent/runs/eval-$(date +%Y-%m-%d).jsonl
```

Runs all 20 sequentially. Writes one result line per task. Aborts the individual task on budget exhaustion, never the sweep.

### Local-only sweep (the headline number)

```bash
bun run eval:go --all --local-only --output ~/.8gent/runs/eval-local-$(date +%Y-%m-%d).jsonl
```

Forces the failover chain to stop at the last local rung. Any task that would have escalated to cloud is recorded as `result: cloud_fallback_blocked` and counts as a fail.

This is the metric we publish on the website.

---

## Pass criteria

### Per task

A task passes if and only if:

1. The verification `check` command exits 0.
2. The receipt verdict is `Done.` (not `Stopped.` or `Needs you.`).
3. The wall-clock did not exceed the `budget_hint.maxWallclockMs`.
4. For local-only sweeps: no cloud provider was invoked.

All four are required. Three out of four is a fail.

### Per sweep

| Metric                            | Target          | Source            |
| --------------------------------- | --------------- | ----------------- |
| Local-only completion rate (wk 1) | >= 60% (12/20)  | This file, success metric |
| Judge-vs-human agreement (day 3)  | >= 70% on 30    | Kill gate, 8EO    |
| Walk-away success rate            | >= 50% (3/6)    | This file, internal |
| Mean cost on cloud-allowed tasks  | < $0.10 / task  | This file, internal |

Below the local-only target on Friday = ship behind `--experimental` flag, reframe as early access, do not put on the homepage. Above the target = front-page launch.

---

## Where results land

- Raw per-run trajectories: `~/.8gent/runs/<run-id>/ledger.jsonl` (hash-chained, 8GO-owned)
- Sweep summary: `~/.8gent/runs/eval-<date>.jsonl` (one line per task)
- Public weekly snapshot: `8gi.org/internal/runs/eval-week-N` (auth-gated, mirrored from local via the Convex sync described in `scripts/sync-agent-mail.ts`)
- Day-3 kill-gate sample: 30 trajectories drawn at random from the week 1 corpus, hand-judged by James + one officer

---

## Who reviews

- **Week 1 daily check-in:** 8PO (Samantha) reports the local-only completion rate at 1700 UTC. Posted to the boardroom Telegram. One number, one chart, no commentary.
- **Day 3 kill gate:** 8EO (Rishi) + James review the 30 sampled trajectories together. Vote: ship / experimental / hold.
- **Week 1 retrospective:** 8PO writes a one-page review covering: which tasks failed most, which categories underperformed, which got removed for v2.

---

## Versioning

This is v1. The set is locked for week 1. No additions, no deletions, no edits to verification commands during the measurement window. That is the entire point of a locked set.

After the week 1 retro:

- v2 may add up to 5 tasks based on real user goals captured in week 1 ledgers.
- v2 may retire any task whose verification was found to be ambiguous in practice.
- Removed tasks stay in `archive/` with the reason they were retired.

Never edit `go-task-set-v1.jsonl` after the lock. Open `go-task-set-v2.jsonl` for v2.

---

## Anti-patterns

- Adding a task whose `verification.method` is `judge-reads-summary`. Rejected by the schema. Every check must be deterministic execution.
- Changing the success metric mid-week to make the number look better. The number is the number.
- Running the eval against a non-default model "to see what it could do". The eval measures shipped defaults. Side experiments go in `bench/` not `eval/`.
- Treating eval failures as bugs in the eval. Sometimes they are. Most of the time they are real product gaps. Default to "the product missed", not "the test is wrong".

---

## Open questions for the boardroom

1. Do we publish the per-task pass/fail breakdown publicly, or only the aggregate? (Default proposal: aggregate publicly, full breakdown on /internal/runs.)
2. When v2 launches, do we keep v1 running in parallel for trend data? (Default proposal: yes, two-week overlap.)
3. Should we accept community-contributed tasks for v2 via PR? (Default proposal: yes, with a checklist gate that enforces deterministic verification.)
