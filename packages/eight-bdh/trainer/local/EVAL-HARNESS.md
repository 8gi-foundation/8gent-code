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

## Status — read this first

> **This is a v1 DIAGNOSTIC instrument, not a release gate.** The
> orchestrator spec section 0.5 (chair amendment, 2026-04-28) already
> demoted the eval harness from a ship gate to a diagnostic. Its numbers
> inform; they do not gate a release.
>
> **The gold set's answer key was authored by a single agent.** All 40
> "correct" labels are one author's reading of a routing contract that,
> until now, only existed implicitly. That contract is now written down
> in `../ROUTING-CONTRACT.md` (v0.1, **proposed, not chair-ratified**).
>
> The 8GI boardroom reviewed the gold set on 2026-05-14 and ratified it
> **with changes** — *as a diagnostic instrument only*. Provenance,
> the boardroom's label changes, and the open conditions (a required
> second blind rater before any tuning-toward; L5 chair ratification of
> the contract) are recorded in `gold_set.provenance.json`. Read that
> file before citing any number from this harness.

## Files

| File | What it is |
|---|---|
| `gold_set.jsonl` | The held-out labelled test set. 40 hand-authored `(state -> correct decision.kind)` pairs, each with an explicit rationale and a difficulty category. Two entries (`g-c03`, marked `disputed`) carry a live officer split awaiting a second rater. |
| `gold_set.provenance.json` | Who labelled the set, against which contract version, what the boardroom changed, and the open conditions. The audit record for the answer key. |
| `../ROUTING-CONTRACT.md` | The routing decision contract (v0.1, proposed) — the precedence-ordered rubric every gold label derives from. Previously implicit; written down after boardroom review. |
| `gold_set_REVIEW.md` | Per-entry review table (request, rationale, blank verdict column) for a second rater or chair review. |
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

- **Hand-authored by AI James** (single author — see Status above and
  `gold_set.provenance.json`), derived from the routing contract in
  `../ROUTING-CONTRACT.md`. Each entry's `rationale` field traces the
  label back to a numbered rule in that contract.
- **A contract-conformance + generalisation test.** Every entry has a
  `category`:
  - `keyword-obvious` (14) -- the routing signal is on the surface; a
    keyword router should get these.
  - `semantic-hard` (12) -- correct routing needs the meaning, not a
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
- **Deliberately hard-weighted.** 19 of 40 entries are `semantic-hard`
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
- **Not multi-rater — yet.** Right now the "gold" is one author's
  reading of the contract. The 8GI boardroom (2026-05-14) made a second
  blind rater + reported inter-rater Cohen's kappa a **hard
  precondition** before this set is ever used as a training or tuning
  signal. See `gold_set.provenance.json` `open_conditions`. Disagreements
  go against `gold_set.jsonl` directly, or `gold_set_REVIEW.md`.
- **Not statistically powered at n=40.** The spec's gates name a
  100-example holdout (Phase 0) and a 5k set (Phase 1). At n=40 the
  "+10pp vs heuristic" delta carries an interval of roughly +/-15pp — a
  checkpoint at 57.5% vs heuristic 47.5% is a *headroom indicator*, not a
  cleared gate. Grow the set before any default-on promotion.

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
heuristic          47.5%       47.5%    0.341     0/40

  heuristic -- accuracy by difficulty tier:
    keyword-obvious         85.7%  (n=14)
    semantic-hard            8.3%  (n=12)
    adversarial-phrasing    14.3%  (n=7)
    policy-edge             71.4%  (n=7)
```

The tier breakdown is the whole story: the keyword router handles the
obvious cases and the policy-driven cases, and falls off a cliff the
moment routing needs semantics. That cliff is the headroom a trained
BDH has to claim.

**Concretely: to clear the Phase 1 "+10pp vs heuristic" gate on this
gold set, a BDH checkpoint needs `kind_accuracy >= 57.5%`.** To clear
the Phase 0 gate it needs `>= 70%`. (Both subject to the n=40 power
caveat above — these are indicators, not certified gates.)

## How to cite the baseline number

The heuristic's 47.5% is honest *in context* and a landmine *out of it*
(8MO's finding). The rule:

- **Never publish the number naked.** "47.5%" alone reads as "8gent's
  router is 47.5% accurate". It is not that.
- **Always travel with the frame:** it is the keyword baseline's score
  *on a deliberately hard-weighted generalisation probe*, n=40, single
  rater. It measures headroom, not a real-world router accuracy rate.
- **When a trained BDH clears 57.5%,** the honest headline is "a
  from-scratch local model learned to route past keywords" — never
  "an X% accurate router".

## Contributing gold entries

The gold set is meant to grow. To add or dispute an entry:

1. Each entry is one JSON object per line in `gold_set.jsonl` with:
   `id`, `category` (one of the four tiers), `state` (`request` +
   `context` + `policy`), `gold` (`kind` + `target_acceptable`), and
   `rationale`. Optional: `disputed: true`.
2. The `gold.kind` must be derivable from a numbered rule in
   `../ROUTING-CONTRACT.md`. State which rule in the `rationale`. An
   entry whose label cannot cite a contract rule does not belong in the
   set — fix the contract first, at L5.
3. To dispute an existing label, set `disputed: true` and add your
   reasoning to the `rationale`, or mark it in `gold_set_REVIEW.md`.
   Disputed entries are the second rater's priority.
4. Run `python3 .../test_eval_harness.py` — it validates schema, unique
   ids, kind/category validity, and that the heuristic still scores
   below 100% (a gold set the keyword router aces is just the heuristic
   restated).

## Why there is no BDH score in this commit

The Phase 0/1/2a/2b checkpoints were M2-Max-local and gitignored, and
the worktree that held them no longer exists -- they are not on disk.
This harness was therefore built and tested in baseline-only mode plus
a fresh-init-model plumbing test. It is ready to score a real checkpoint
the moment the next training run produces one. That is the correct
order of operations: the eval harness is the thing you build *before*
the run, so the run is measurable.

## Next

Boardroom-set conditions (2026-05-14), in order:

1. **Second blind rater** relabels all 40 entries; report inter-rater
   Cohen's kappa. This is the hard precondition before the set is used
   as any training or tuning signal. Start with the disputed/changed
   entries listed in `gold_set.provenance.json` `second_rater_priority`.
2. **L5 chair ratification** of `../ROUTING-CONTRACT.md` v0.1 (and its
   `authority_level < 3` threshold). Until then the contract stays
   `proposed` and the harness stays diagnostic-only.
3. Run the next BDH training phase. Score its checkpoint with
   `--checkpoint`. The report produces a `spec_gates` verdict — read it
   as an indicator, not a certified pass, until conditions 1-2 close.
4. Grow `gold_set.jsonl` toward the spec's 100 / 5k targets, with
   deliberate minimal-contrast pairs (vary one of authority / deny-list
   / budget / history). The harness is already `--gold`-size-agnostic.
5. When labelled production routing logs exist, add them as a second
   `--gold` file and report both.
