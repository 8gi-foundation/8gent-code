# BDH routing eval harness

The Phase 2 synthesis (`PHASE-2-SYNTHESIS.md`, section 7) named this as
priority #1 for what comes after the autonomous training window:

> Build the eval harness (Phase 1 prereq). Now we have checkpoints of
> meaningfully different behaviour to measure against. Heuristic
> baseline + held-out gold set + kappa probe.

Until this existed, every BDH phase report could only cite byte-level
`val_loss`. `val_loss` tells you the model learned the corpus
distribution. It does not tell you whether the model **routes
correctly**, which is the entire point of 8gent 0.1 per the orchestrator
spec. This harness closes that gap.

## Files

| File | What it is |
|---|---|
| `gold_set.jsonl` | The held-out labelled test set. 40 hand-authored `(state -> correct decision.kind)` pairs, each with an explicit rationale and a difficulty category. |
| `eval_harness.py` | The scorer. Loads the gold set, scores the heuristic baseline always, scores a BDH checkpoint if given one, computes accuracy + Cohen's kappa + a confusion matrix + per-tier breakdown + single-forward-pass latency. Writes `eval-report.json`. |
| `test_eval_harness.py` | 21 tests: kappa math against hand-verified values, gold-set integrity, malformed-input rejection, scorer self-consistency, heuristic sanity, and the BDH decode-path plumbing (an untrained model runs through the pipeline without error). |
| `baseline_heuristic.py` | (pre-existing) The deterministic `HeuristicRouter` the harness scores as the baseline. |

## How to run

```bash
# Baseline only -- no checkpoint needed. This is the expected mode today.
python3 packages/eight-bdh/trainer/local/eval_harness.py

# Score a trained checkpoint against the gold set.
python3 packages/eight-bdh/trainer/local/eval_harness.py \
    --checkpoint packages/eight-bdh/checkpoints/phase-3c-toolcalls-5m.pt

# Custom gold set / output / device.
python3 packages/eight-bdh/trainer/local/eval_harness.py \
    --gold path/to/gold.jsonl --out path/to/report.json --device cpu

# Tests.
python3 packages/eight-bdh/trainer/local/test_eval_harness.py
```

The harness exits 0 on a clean run regardless of score. It is a
measurement tool, not a CI gate. The ship-gate decision is made by a
human reading `eval-report.json`.

## What the gold set IS

- **Hand-authored by AI James**, derived from the routing contract
  implied by the orchestrator spec and the `HeuristicRouter`'s intent.
  Each entry's `rationale` field traces the label back to that contract.
- **A contract-conformance + generalisation test.** Every entry has a
  `category`:
  - `keyword-obvious` (15) -- the routing signal is on the surface; a
    keyword router should get these.
  - `semantic-hard` (11) -- correct routing needs the meaning, not a
    trigger word.
  - `adversarial-phrasing` (7) -- deliberately phrased to trip keyword
    matching (a destructive action with no trigger word, a reasoning
    task that contains the word "review", etc.).
  - `policy-edge` (7) -- routing is decided by budget / authority /
    deny-list, not by the request text.
- **Scored on `decision.kind` exactly** (the metric both spec section 9
  gates name), and on `decision.target` by an *acceptable set* rather
  than exact string -- exact target strings are too brittle to score, so
  each entry lists `target_acceptable` (a list, or `["*"]` meaning "kind
  is what matters here").
- **Deliberately hard-weighted.** 18 of 40 entries are `semantic-hard`
  or `adversarial-phrasing`. This is a generalisation probe by design:
  keyword routing is brittle, and the question this harness exists to
  answer is whether a trained BDH learns *past* keywords.

## What the gold set is NOT

- **Not production traffic.** We have no labelled production routing
  logs. When we do, they become a second, larger gold file -- the
  harness already takes `--gold` for exactly that.
- **Not the 5k held-out test set** the spec's Phase 1 gate names. This
  is v1, n=40. It is enough to score the Phase 0 "70% kind accuracy"
  gate meaningfully and to make "+10pp vs heuristic" a concrete number.
  It is a seed and a template, not the final word.
- **Not a claim that keyword routing scores 47.5% in the wild.** The
  47.5% below is the heuristic's score *on a deliberately hard-weighted
  set*. It measures headroom, not the heuristic's real-world rate.
- **Not multi-rater.** A second human labeller would strengthen it.
  Right now the "gold" is one informed author's reading of the contract.
  Disagreements should be filed against `gold_set.jsonl` directly.

## What the harness measures

| Metric | Meaning |
|---|---|
| `kind_accuracy` | Fraction of entries where predicted `decision.kind` == gold. The headline; both spec section 9 gates are stated in these terms. |
| `target_accuracy` | Fraction where kind is correct AND target is in the acceptable set. Always <= kind_accuracy. |
| `cohens_kappa_vs_gold` | Agreement with gold corrected for chance given the label distribution. Raw accuracy flatters a router on a skewed set; kappa does not. 1.0 = perfect, 0.0 = chance, negative = worse than chance. |
| `by_category` | Accuracy per difficulty tier. The honest breakdown -- a router can look fine overall and be blind on `semantic-hard`. |
| `by_kind` | Accuracy per gold decision kind. Surfaces "the model can do `tool` but never `reject`". |
| `confusion_gold_x_pred` | Where the errors go. `clarify` mistaken for `agent` is a different failure from `clarify` mistaken for `model`. |
| `undecodable_rate` | (BDH only) How often the model's byte stream did not parse to a valid Decision. |
| `latency` | (BDH only) Single-forward-pass p50/p95/mean in ms. This is the **production routing path** -- not 80-byte autoregressive generation, which the Phase 0 verify script wrongly measured (see the BDHTraining skill's lessons table). |

## Mapping to spec section 9 ship gates

When run with `--checkpoint`, the report's `spec_gates` block evaluates:

| Gate | Spec text | How the harness checks it |
|---|---|---|
| `phase_0_70pct_kind_acc` | "70%+ decision-kind accuracy on 100-example toy holdout" | `bdh.kind_accuracy >= 0.70` on the gold set. (n=40 here, not 100; grow the gold file to close that gap.) |
| `phase_1_plus_10pp_vs_heuristic` | "+10pp routing accuracy vs heuristic baseline on 5k held-out test set" | `bdh.kind_accuracy - heuristic.kind_accuracy >= 0.10`. (n=40 here, not 5k.) |
| `phase_1_p95_latency_80ms` | "p95 inference latency <=80ms locally" | `bdh.latency.p95_ms <= 80.0`, measured as a single forward pass. |

The gates the harness does **not** cover (they need infrastructure
beyond a scorer): the `benchmark:v2` frontier-call reduction, the
audit-trace coverage, and the human trace-usefulness rating.

## Baseline as of this commit

Run: `python3 packages/eight-bdh/trainer/local/eval_harness.py`

```
router          kind acc  target acc    kappa   undecod
-------------------------------------------------------
heuristic          47.5%       47.5%    0.344     0/40

  heuristic -- accuracy by difficulty tier:
    keyword-obvious         80.0%  (n=15)
    semantic-hard            9.1%  (n=11)
    adversarial-phrasing    14.3%  (n=7)
    policy-edge             71.4%  (n=7)
```

The tier breakdown is the whole story: the keyword router handles the
obvious cases and the policy-driven cases, and falls off a cliff the
moment routing needs semantics. That cliff is the headroom a trained
BDH has to claim.

**Concretely: to clear the Phase 1 "+10pp vs heuristic" gate on this
gold set, a BDH checkpoint needs `kind_accuracy >= 57.5%`.** To clear
the Phase 0 gate it needs `>= 70%`.

## Why there is no BDH score in this commit

The Phase 0/1/2a/2b checkpoints were M2-Max-local and gitignored, and
the worktree that held them no longer exists -- they are not on disk.
This harness was therefore built and tested in baseline-only mode plus
a fresh-init-model plumbing test. It is ready to score a real checkpoint
the moment the next training run produces one. That is the correct
order of operations: the eval harness is the thing you build *before*
the run, so the run is measurable.

## Next

1. Run the next BDH training phase. Score its checkpoint with
   `--checkpoint`. The report now produces a real `spec_gates` verdict.
2. Grow `gold_set.jsonl` toward the spec's 100 / 5k targets. The harness
   is already size-agnostic; this is purely authoring effort, ideally
   with a second labeller.
3. When labelled production routing logs exist, add them as a second
   `--gold` file and report both.
