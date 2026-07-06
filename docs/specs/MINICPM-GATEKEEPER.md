# MiniCPM5-1B as the Harness Gatekeeper

Status: Proposed (design-only, no source changes yet)
Owner: James Spalding
Related: `docs/specs/UNIVERSAL-DESIGN-CONTEXT.md`, No-PII-to-cloud rule

## Problem (one sentence)

The harness routes tasks and judges outputs with models that are either bigger
than the job needs (qwen3.5 classifier) or sitting in the cloud (Gemini-Flash
kernel judge); a 1B on-device model that natively tool-calls and *abstains
instead of hallucinating* is a strictly better fit for both the routing decision
and the verdict gate.

## Constraint

- **No new provider.** MiniCPM5-1B ships on Ollama (`openbmb/minicpm5`), and
  `ollama` is already an `enabled: true` provider. This is a `pull` + registry
  edit, not a new client.
- **Judge must differ from executor.** `packages/goal/judge.ts` already enforces
  `assertDistinctJudge(executorModel, judgeModel)` -> `JudgeExecutorCollisionError`.
  A dedicated small judge model is something the architecture already expects.
- **Fail closed to local.** Aligns with the no-PII-to-cloud hard rule: replacing
  the cloud judge removes an egress path entirely.

## What we are NOT doing

- Not making MiniCPM a generation model. It never writes code, prose, or UI.
  It **routes** and it **judges**. Two seats, nothing else.
- Not removing the existing judges. Apple Foundation (apfel) stays the on-device
  QA reviewer in `role-registry.ts`; MiniCPM replaces the *cloud* kernel judge
  and becomes the default local goal-judge, both behind a flag.
- Not touching the failover *executor* chains for code/writing tasks.

## Success metric

A benchmark (`benchmarks/autoresearch/judge-abstain-bench.ts`, new) showing, over
a fixed set of good + deliberately-broken artifacts:

1. MiniCPM5-1B judge **false-approve rate <= the current Gemini-Flash judge**
   (it should be lower — it abstains on uncertainty).
2. **Zero cloud calls** on the judge path when the flag is on (assert via the
   PII-egress counter / `isCloudProvider()`).
3. Judge p50 latency within 2x of Gemini-Flash (local, no network RTT — expected
   to win on p50 despite smaller hardware).

## Why MiniCPM5-1B (verified, June 2026)

- SOTA 1B on-device LLM (OpenBMB). Native tool calling + MCP; XML-style tool
  calls auto-convert to OpenAI-compatible tool APIs.
- **AA-Omniscience score of -1, best in its size class, achieved by abstaining
  rather than guessing** -> the ideal *conservative gate*. A false "unsure" is
  cheap (escalate); a false "approve" ships a bug. Abstention is the feature.
- Official Ollama publish: `openbmb/minicpm5`. GGUF quants (Q3_K_M fits 8GB,
  Q4_K_M recommended, Q8_0 for 32GB+).

Sources: artificialanalysis.ai MiniCPM5-1B article; github.com/openbmb/minicpm;
ollama.com/openbmb/minicpm5; huggingface.co/openbmb/MiniCPM5-1B-GGUF.

---

## The two seats (with exact wiring)

### Seat 0 (prerequisite) — register the model

`packages/providers/index.ts`, the `ollama` entry (currently line 236):

```diff
- models: ["qwen3.6:27b", "qwen3.5:latest", "qwen3:14b", "devstral:latest", "eight:0.1"],
+ models: ["qwen3.6:27b", "qwen3.5:latest", "qwen3:14b", "devstral:latest", "eight:0.1", "minicpm5:latest"],
```

`packages/providers/failover.ts`, `defaultTextChains()`: add a chain keyed by
`minicpm5:latest` (or the resolver silently reroutes unknown models to OpenRouter
per `resolve()` at ~line 214). Minimal chain -> local first, no cloud tail for
the judge seat:

```
"minicpm5:latest": [ { provider: "ollama", model: "minicpm5:latest" } ]
```

Model id note: the Ollama tag is `openbmb/minicpm5`. Pull it and, if we want the
short id `minicpm5:latest`, `ollama cp openbmb/minicpm5 minicpm5:latest` in the
bootstrap, OR use the full tag in the registry. Spec assumes short id for
readability; implementer picks one and is consistent across all three files.

### Seat 1 — the route / tool-call classifier

`packages/ai/task-router.ts`, `DEFAULT_CONFIG` (line 68):

```diff
- classifierModel: "qwen3.5:latest",
+ classifierModel: "minicpm5:latest",
  classifierProvider: "ollama",
```

Rationale: `classify(prompt)` is a *decision* (code/reasoning/simple/creative),
not generation. MiniCPM's native tool-calling head is built for exactly this, at
a fraction of qwen3.5's footprint, freeing that RAM slot for the executor.
Behind flag `EIGHT_ROUTER_MINICPM=1` (default off in phase 1, on after bench).

The `slots` (executor models per category) are UNCHANGED — MiniCPM only replaces
the classifier that *picks* the slot.

### Seat 2 — the verdict judge (replaces the CLOUD judge)

Two judge paths get MiniCPM; the third (apfel QA) stays as-is.

**2a. Kernel scorer** — `packages/kernel/judge.ts`, `DEFAULT_JUDGE_CONFIG` (line 67):

```diff
- prmModel: "google/gemini-2.5-flash:free",
+ prmModel: "minicpm5:latest",   // local, on-device; was cloud OpenRouter
```

This is the headline change James approved: the kernel PRM-style scorer stops
calling OpenRouter and judges on-device. Criteria weights (executionSuccess .4 /
codeQuality .2 / toolEfficiency .2 / directness .2) unchanged.

**2b. Goal-loop local judge** — `packages/goal/judge-failover.ts`,
`DEFAULT_LOCAL_JUDGE` (line 50):

```diff
- const DEFAULT_LOCAL_JUDGE = "apple-foundationmodel";
+ const DEFAULT_LOCAL_JUDGE = "minicpm5:latest";
```

Keep apfel as the *fallback* in the chain so hosts without MiniCPM pulled still
judge locally. `assertDistinctJudge()` continues to guarantee judge != executor;
since executors are eight/gemma/qwen, MiniCPM as judge always passes that guard.

**2c. Arena judge** — `benchmarks/autoresearch/arena-judge.ts`
(`JUDGE_MODEL = "google/gemini-2.5-flash"`): OUT OF SCOPE for phase 1. The arena
is a benchmark harness where a stronger cloud judge is acceptable as ground
truth. Leave it; note it here so nobody "helpfully" swaps it and loses the
reference judge we benchmark MiniCPM *against*.

---

## Rollout (phased, flagged, reversible)

| Phase | Change | Flag | Gate to next |
|---|---|---|---|
| 0 | Bootstrap pulls `openbmb/minicpm5`; registry + failover entries | n/a | model resolves in a smoke test |
| 1 | Judge seat (2a + 2b) behind `EIGHT_JUDGE_MINICPM` | off | abstain-bench green |
| 2 | Router seat (1) behind `EIGHT_ROUTER_MINICPM` | off | router-stats show no regression in task-class accuracy |
| 3 | Flip both defaults on; keep flags for rollback | on | one week soak on helm/forge |

## Rollback

Each seat is a one-line revert of a default string. Flags let us flip without a
deploy. No schema, no migration, no data change. Blast radius: 4 files
(`providers/index.ts`, `providers/failover.ts`, `ai/task-router.ts`,
`kernel/judge.ts`, `goal/judge-failover.ts`) + 1 new bench file.

## Open questions

- Ollama tag hygiene: use full `openbmb/minicpm5` everywhere vs `ollama cp` to a
  short id. Recommend short id via bootstrap for readability.
- Does MiniCPM's XML tool-call format round-trip cleanly through the ollama
  client's tool adapter? Verify in the phase-0 smoke test before Seat 1.
- Quant choice on forge (96GB) vs helm: Q8_0 on both is affordable at 1B.
