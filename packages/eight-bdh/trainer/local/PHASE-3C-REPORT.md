# Phase 3c: tool-call corpus — 5M BDH

**Run date:** 2026-05-14
**Author:** AI James, applying the BDHTraining skill
**Branch:** `feat/eight-bdh-phase-3c`
**Status:** complete — checkpoint scored against the routing eval harness

## TL;DR

Phase 3c trained a 5M BDH on a 113.6 MB corpus of pure tool-call
exchanges. It reached **byte-loss val 0.8626 — the best of any BDH run
to date**, beating even the 10M Phase 2b, in 61.7 min (early-stopped).

Then the routing eval harness scored the checkpoint: **0/40, every
entry undecodable.** The model learned to *continue tool-call
transcripts* (it produces clean `<<toolcall:Bash>>` exchanges — verified
by probe), but the corpus never contained the `Decision` JSON schema
the orchestrator contract needs, so it cannot emit a routing decision.

The headline is not the checkpoint — it is the methodology. The eval
harness, built and merged this morning, caught on its first real
checkpoint that "best byte-loss ever" and "can route" are unrelated.
Without it, 0.8626 ships as progress. With it, the real next step is
clear: the routing core needs a corpus of routing *decisions*, not
tool-call *transcripts*. Latency, separately, clears the ≤80ms gate
(p95 45.4ms).


## 1. Hypothesis

Phase 2 established that corpus *size* is the dominant lever and capacity
is secondary (Phase 2a 5M and Phase 2b 10M on the same 5.67 MB
heterogeneous corpus landed val_loss 0.934 and 0.885). Phase 3c tests a
different lever: corpus *shape*. The corpus here is **only tool-call
exchanges** — every assistant `tool_use` paired with its `tool_result`,
extracted from the Claude Code session JSONLs — on the theory that
BDH's intended role is the routing core, so a corpus made entirely of
routing-shaped data should produce a sharper signal at fixed 5M params.

## 2. Corpus

| Field | Value |
|---|---|
| Source | `~/.claude/projects/**/*.jsonl` — 4,973 session files, 2,038 with tool calls |
| Extraction | every `tool_use` + matching `tool_result`, tagged `<<toolcall:NAME>>\n{input}\n<<toolresult>>\n{result}\n<<endtoolcall>>` |
| Tool exchanges | 89,331 |
| Size | **113.6 MB** (`113,600,981` bytes) |
| Train / val split | 107.9 MB / 5.68 MB (95/5) |
| Input cap | 800 chars per `tool_use` input |
| Result cap | 2,000 chars per `tool_result` body |
| PII scrub | canonical regex (email, phone with ISO-timestamp guard, OpenAI/GitHub/xAI/Anthropic keys), client-name redaction |
| Seed | 45 |

Top tools by frequency: Bash 41,738 · Read 18,031 · Edit 8,655 ·
Write 4,094 · Grep 3,035 · Glob 2,470 · chrome computer 1,781 ·
WebSearch 1,221.

**Deviation from the trainer's stated plan.** The trainer docstring
guessed "~5 MB, similar byte budget to Phase 2". The real extraction
came out at 113.6 MB — 20x larger and 20x the Phase 2 corpus. This
turns Phase 3c into a test of corpus *shape AND volume* together, not
shape alone. The result still answers the question that matters
(does a tool-call corpus train a better BDH?), but the clean
shape-at-fixed-volume comparison to Phase 2a is no longer exact. Noted
honestly rather than papered over.

**Reproducibility caveat.** The corpus is rebuilt from live session
JSONLs each run; those files grow continuously, so `BDH_SEED=45` fixes
the shuffle but not the source bytes. The smoke run and the full run
produced corpora differing by 5 exchanges (89,326 vs 89,331) and
different SHA-256. For an exact reproduction, freeze
`packages/eight-bdh/data/phase-3c-toolcalls-corpus.bin` (gitignored)
and its manifest.

## 3. Training

| Setting | Value | Source |
|---|---|---|
| Architecture | BDH 5M, paper-faithful single-head NTP | `PHASE_0_5M_CONFIG` |
| Hyperparameters | block 512, batch 32, lr 1e-3, AdamW wd 0.1 | verbatim Pathway |
| Defensible deviations | grad clip 1.0, no mixed precision / no `torch.compile` on MPS, early stopping | BDHTraining skill |
| Max iters | 2,500 (early-stop patience 300) | trainer default |
| Device | MPS (M2 Max) | — |

**Early-stopped at iter 1,400** — no validation improvement in 300
iters. Best `val_loss` was reached around iter 1,100.

| Iter | train_loss | val_loss |
|---|---|---|
| 1 | 5.538 | 5.321 |
| 100 | 2.989 | 3.002 |
| 200 | 2.042 | 2.114 |
| 300 | 1.548 | 1.719 |
| 500 | 1.249 | 1.213 |
| 1,000 | 0.915 | 0.974 |
| 1,400 (final) | 0.876 | 0.893 |
| **best** | — | **0.8626** |

Wall clock: **61.7 min**. The curve descended cleanly throughout, val
tracked train within ~5% the entire run — no overfit signal, no NaN.
The slower per-iter descent versus prior runs is expected and healthy:
at 113.6 MB the model cannot memorise its way down, it has to learn a
distribution. (See the BDHTraining lesson "<5MB → memorisation"; this
run is the opposite regime.)

## 4. Four-run comparison

| Run | Params | Corpus | Iters | Best val_loss |
|---|---|---|---|---|
| Phase 2a | 5M | 5.67 MB heterogeneous | 2,500 | 0.934 |
| Phase 2b | 10M | 5.67 MB heterogeneous | 2,000 | 0.885 |
| **Phase 3c** | **5M** | **113.6 MB tool-calls** | **1,400 (early-stop)** | **0.8626** |

Phase 3c reaches the lowest byte-level val_loss of any run so far — at
5M params, beating even the 10M Phase 2b — and it did so in fewer
iterations. Two levers are confounded here (shape *and* volume), so the
honest read is "a large, routing-shaped corpus trains the best BDH to
date on byte loss", not "shape alone beat capacity". Byte loss is not
routing correctness, however — that is what the eval harness measures,
in section 5.

## 5. Routing eval — the harness verdict

The Phase 3c best-val checkpoint scored against the routing eval gold
set (`eval_harness.py --checkpoint phase-3c-toolcalls-5m-best-val.pt`):

| Router | kind acc | target acc | kappa | undecodable |
|---|---|---|---|---|
| heuristic baseline | 47.5% | 47.5% | 0.341 | 0/40 |
| **Phase 3c BDH** | **0.0%** | **0.0%** | **0.000** | **40/40** |

| Spec section 9 gate | Result |
|---|---|
| Phase 0 — ≥70% kind accuracy | **NOT MET** (0.0%) |
| Phase 1 — +10pp vs heuristic | **NOT MET** (−47.5pp) |
| Phase 1 — p95 latency ≤80ms | **PASS** (p50 38.4ms, p95 45.4ms) |

**Every one of the 40 gold entries was undecodable** — the model's byte
stream never parsed to a valid `Decision`. This is not a harness bug
and not a training failure. It is a verified corpus-shape finding.

Two probes confirm the cause:

- **Probe A — harness-style prompt.** Given the gold state JSON plus the
  decision opener `,"decision":{`, the model continues with
  `"type":"text","text":"\n\nTab Context:..."` — it pattern-matches the
  JSON-ish prefix and emits *`tool_result` content* shapes. It never
  produces `"kind":"..."` because that schema string does not exist
  anywhere in the Phase 3c corpus.
- **Probe B — native prompt.** Given `<<toolcall:Bash>>`, the model
  produces a clean, well-formed tool-call exchange: valid command JSON,
  the `<<toolresult>>` tag, a structured result body. Given
  `<<toolcall:Read>>\n{"file_path":"` it completes a plausible path and
  a structured result. **The model genuinely learned the tool-call
  transcript format it was trained on.**

The corpus taught the model to *continue tool-call transcripts*. The
orchestrator contract and the eval harness need the model to *emit a
routing Decision* (`{"kind":"tool","target":"Bash",...}`). Those are
two different output tasks, and the Phase 3c corpus only contains the
first. Byte-loss 0.8626 measured how well the model learned its corpus;
it did. It did not measure routing, because the corpus was not routing.

## 6. What this proves and does not prove

**Proves:**
- The eval harness earned its keep on its first real checkpoint.
  Without it, byte-loss 0.8626 — the best of four runs — would have
  been reported as the strongest BDH yet and quietly assumed to be
  progress toward a router. It is not. The harness caught that
  "best byte-loss" and "can route" are unrelated for this corpus.
- BDH trains cleanly and fast on a large (113.6 MB), single-shape
  corpus: 61.7 min, early-stopped, no NaN, no overfit, best byte-loss
  of any run to date at 5M params.
- The 5M BDH single-forward-pass latency clears the Phase 1 ≤80ms gate
  with wide margin (p95 45.4ms) — a real, training-independent result.
- The model can produce well-formed tool-call exchanges. That is a
  narrow but genuine capability (mock tool-call generation, transcript
  completion).

**Does not prove:**
- Anything about routing. 0/40 decodable means routing accuracy is
  unmeasured, not measured-low.
- That the tool-call corpus *shape* is wrong for the routing core —
  only that this corpus, on its own, does not teach the Decision
  output schema. Tool-call data may still be the right *input* signal;
  it just has to be paired with Decision *targets*.
- That corpus shape beats capacity. Phase 3c's byte-loss win is
  confounded by 20x the corpus volume (see section 2 deviation note).

## 7. Next

The path is now unambiguous, and it is a corpus problem, not a model
problem:

1. **Build a routing-decision corpus.** The routing core needs
   `(state → Decision)` pairs in the contract JSON schema from
   `packages/eight-bdh/ROUTING-CONTRACT.md` — not tool-call transcripts.
   Phase 0's rule-based corpus had the right *shape* but was synthetic
   and memorised. The need: realistic harness states paired with
   correct Decisions, labelled by the (boardroom-reviewed) routing
   contract. This is the real Phase 4.
2. **Consider tool-call data as input, not target.** The Phase 3c
   corpus is rich `(request → tool chosen)` signal. Reframed as
   `(state → {"kind":"tool","target":NAME})` it becomes routing
   training data for the `tool` kind. It cannot teach
   reject/clarify/agent/model — those need their own examples.
3. **Optional bridge: a decode adapter.** The model emits clean
   `<<toolcall:NAME>>` (Probe B). A harness adapter could map that to
   `{"kind":"tool","target":NAME}` and recover the `tool`-kind entries
   without retraining. This is a partial measurement bridge, not a
   fix — it cannot express the other four kinds — so it is a
   nice-to-have, not the plan.
4. **Keep the checkpoint.** Phase 3c best-val is the best byte-LM BDH
   we have and a genuine tool-call-transcript generator. It is not the
   router, but it is not waste.

## Artifacts

| Artifact | Path | Committed? |
|---|---|---|
| Checkpoint (best-val) | `packages/eight-bdh/checkpoints/phase-3c-toolcalls-5m-best-val.pt` | no (gitignored) |
| Checkpoint (final iter) | `packages/eight-bdh/checkpoints/phase-3c-toolcalls-5m.pt` | no (gitignored) |
| Corpus | `packages/eight-bdh/data/phase-3c-toolcalls-corpus.bin` | no (gitignored) |
| Corpus manifest | `packages/eight-bdh/data/phase-3c-toolcalls-manifest.json` | yes |
| Training log | `packages/eight-bdh/trainer/local/phase-3c-toolcalls-train-log.json` | no (gitignored — full loss curve; key points in section 3) |
| Eval report | `packages/eight-bdh/trainer/local/phase-3c-eval-report.json` | yes |
| This report | `packages/eight-bdh/trainer/local/PHASE-3C-REPORT.md` | yes |
