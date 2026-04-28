# 8gent 0.1 - BDH Orchestrator Spec

**Status:** Draft (boardroom directive, 2026-04-28)
**Owners:** 8EO (James), 8TO (Rishi), 8GO (Solomon)
**Targets:** `packages/eight-bdh/` (new), `packages/orchestration/`, `packages/g8way/`
**Repo:** github.com/pathwaycom/bdh (MIT, upstream)

---

## 0. Constraints box (No-BS gate)

| Field | Value |
|---|---|
| **Problem (1 sentence)** | The 8gent harness has no sovereign reasoning core for routing, dispatch, and governance decisions; it leans on frontier APIs or the local generalist `eight-1.0-q3:14b` for tasks that should be cheap, fast, and auditable. |
| **Constraint** | Must stay free and local by default (Principle 2). Must produce auditable routing decisions (G8WAY requirement). Must be small enough to run on the same host as the TUI without competing with `eight-1.0` for VRAM. |
| **NOT doing** | (a) Replacing `eight-1.0-q3:14b` as the generalist code-writer. (b) Training a frontier-capable generalist. (c) Building bespoke training infra; we use BDH upstream. (d) Cloud-only inference - the model has to run locally first. |
| **Success metric** | A 10M-100M parameter BDH model that decides "which model / which agent / which tool" with measurable accuracy uplift over the current heuristic router AND produces a per-decision interpretability trace usable by G8WAY audit logs. Specific gates listed in Section 9. |
| **Estimated scope (Phase 0+1 only)** | New package `packages/eight-bdh/` (~600 LOC TypeScript wrapper). One Python training repo fork. ~5k synthetic routing pairs. No changes to `eight-1.0` or the daemon protocol. |

---

## 0.5 Use case framing — implicit evolution (chair amendment 2026-04-28)

The original framing of this spec was prescriptive: "8gent 0.1 is a routing core. Train it on 50k labelled routing triples. Measure it as a router. Ship when it beats the heuristic by 10pp."

**Chair amendment 2026-04-28:** the model's purpose is left open. Phase 1 is not a labelled-corpus-driven router-training programme. Phase 1 is **implicit evolution on the harness's natural data stream**.

The principle: do not explicitly define what the brain is for. Let it absorb the actual life of the harness — real session traces, real decisions, real audit logs, real conversations — and let its capabilities surface from what the data shapes it into. Quality of the stream is what matters, not curation against a hypothesised use case.

What this means in practice:

- **Corpus is the harness's reality, not a synthetic 50k.** Replays from `~/.8gent/sessions/`, audit traces from G8WAY, boardroom transcripts, 8gent.world content, anything that already exists in the world we want the brain to live in. PII scrub still mandatory; curation by intent is not.
- **No hard Phase 1 ship gates against the routing rubric.** The +10pp F1, the gold-set kappa, the per-concept synapse precision targets in section 4 stay alive **only** for the moment we promote the model to a default-on path that affects user behaviour. During the exploratory phase, the ship-gate concept does not apply because there is nothing being shipped.
- **No fixed ontology.** Section 4.4's 120-concept vocabulary becomes a probe vocabulary, not a prediction target. After training we run the probe runner and see what concepts the synapses actually carry. The ontology is descriptive of the model, not prescriptive over it.
- **Post-training capability discovery.** Once trained on the harness stream, we probe what the model is unexpectedly good at: completing audit traces, suggesting next decisions, summarising sessions, answering "what just happened" — whatever surfaces. Capabilities that surface are documented and (selectively) wired into the harness behind feature flags.
- **The routing use case stays as a hypothesis, not a commitment.** If post-training probing shows the model routes well, great — Throne PRD W1 wires it up. If it shows the model is better at, say, session summarisation, we wire that instead. Or both. Or neither.

What stays unchanged from the original spec:

- BDH architecture (paper-faithful, single-head next-token CE, no concept supervision).
- 0% closed-weight teacher contamination. Apache 2.0 / MIT only.
- Provenance manifest on every byte of corpus. PII scrub plus k-anonymity.
- License compliance (NOTICES.md, the MIT-Apache combination).
- Constant-memory inference, byte-level vocab=256.
- The original boardroom commitments around audit-as-evidence, monosemanticity-as-emergent, and the L5 amendment process for any change at the constitutional layer.

What is consciously deferred:

- The 200-example dual-labelled gold set as a Phase 1 entry gate. It still has value as one possible probe surface, but it does not gate corpus generation or training.
- The eval harness's hard ship gates. The harness as infrastructure (kappa, probe, holdout-discipline) still gets built per the Phase 1 prereq PRD, but its outputs become diagnostic, not gating.
- The 10pp F1 target vs heuristic. The heuristic baseline remains useful as a comparison artefact; it does not function as a release gate during exploration.

**Why this is the right call.** Phase 0 results showed two things: (1) BDH at 5M learns its corpus extremely fast, capacity is not the bottleneck, and (2) the rule-based corpus produced a model with no semantic content because the labels were random. Both findings point in the same direction: spend the energy on data quality, not on schema design. The harness already produces high-quality data every session. Use that.

**Reversibility.** This amendment is reversible at L5. If the implicit-evolution approach fails to produce a useful capability after a meaningful amount of training (say, 3 to 5 Phase 1 runs across distinct corpus snapshots), the boardroom may reinstate the explicit routing-rubric path.

**Authority:** Chair (James Spalding) decision 2026-04-28, recorded against this spec as a superseding framing for sections 4 (corpus), 9 (success metrics), and the eval-harness PRD's gate semantics. Sections 1, 2, 3, 5, 6, 7, 8, 10, 11 remain as written. Section 4.4b (role-name targets) still applies wherever the corpus DOES contain decision triples, but no longer obligates the corpus to be made of decision triples.

---

## 1. What is 8gent 0.1

8gent 0.1 is the **first custom-trained model in the 8gent family** and the first model in the new `8gent-*` namespace (distinct from the existing `eight-1.0-*` generalist line).

It is built on the **Baby Dragon Hatchling (BDH)** architecture (Pathway, MIT, github.com/pathwaycom/bdh) - a brain-inspired transformer alternative with four properties that map cleanly to 8GI principles:

| BDH property | 8GI principle it serves |
|---|---|
| Linear attention, constant-memory inference | Free and local by default - runs on CPU or modest GPU, no VRAM blowup with context |
| Monosemantic synapses (each weight maps to one feature) | G8WAY auditability - every routing decision has a readable activation trace |
| Model merging by concatenation (no retraining) | Hyper-personalisation - tenant-specific expert modules attach without rebuilding the base |
| GPT-2 scaling-law parity from 10M to 1B | Tractable training budget - we can target 10M for v0.1 and grow |

8gent 0.1 is **not a generalist**. It is a small, specialised reasoning core whose job is **orchestration**:

1. Read the user's request plus harness state (open files, tools available, vessel inventory).
2. Decide: route to which model, dispatch which sub-agent, pick which tool, with what budget.
3. Emit a structured decision plus an auditable activation trace for G8WAY.

Generalist work (writing code, drafting prose, debugging) continues to flow through `eight-1.0-q3:14b` or frontier providers. 8gent 0.1 is the **dispatcher**, not the workhorse.

### Naming

Per `project_model_versioning.md` (model SemVer):

- Family: `8gent` (new, distinct from `eight`)
- Version: `0.1.0` (alpha, expected to change)
- Architecture tag: `bdh`
- Role tag: `r` (router/orchestrator)
- Param count: `10m`

Canonical id: `8gent-0.1.0-bdh-r:10m`. Aliased as `8gent-0.1` in user-facing surfaces.

---

## 2. Why this matters (strategic plan)

### 2.1 The sovereignty problem

Today the orchestration logic in `packages/orchestration/` (task-dispatcher, role-runner, capability-catalog) is a mix of hand-written heuristics, role config (`role-config.ts`), and on-demand calls into whatever generalist is loaded. Three problems:

1. **Heuristics don't learn.** `task-dispatcher.ts` does not improve from session to session. The reflection loop in `packages/self-autonomy/` writes lessons to memory, but those lessons never become weights.
2. **Generalist routing is wasteful.** Asking a 14B-parameter generalist "should this go to Claude or to the local model?" burns ~100x the compute the decision deserves.
3. **No audit trail by construction.** When the harness picks Claude over the local model, there is no readable reason in the log other than "the generalist suggested it." G8WAY (`packages/g8way/`) needs structured, replayable routing evidence.

8gent 0.1 closes all three: it is small (cheap), it learns (we train it), and its monosemantic activations are the audit trail.

### 2.2 The interpretability moat

Most orchestration LLMs are opaque. We choose BDH specifically because monosemanticity gives us something competitors don't have: **the routing decision and the reasoning trace are the same artifact**.

For G8WAY this is foundational. The Constitution requires that high-authority actions (Levels 3-5 in `g8way`'s authority hierarchy) carry a justification chain. With a softmax-attention router, justification is post-hoc rationalisation. With BDH, the activated synapses are the justification, and we can label them ahead of time.

This is also a **trust story** for tenants. "Here are the 12 synapses that fired when your vessel decided to escalate to Claude. You can see they correspond to: code-complexity, security-sensitivity, deadline-pressure, tool-availability ..." That is the kind of evidence enterprise buyers ask for and most agent platforms cannot produce.

### 2.3 Modular intelligence by concatenation

BDH's headline feature for our economics is **model merging by concatenation**: train a small expert module on a domain (legal drafting routing, gamedev routing, food-industry routing) and append it to the base. No retraining, no fine-tune drift, no quantisation hell.

The product implication: each tenant on a vessel can have their **own** orchestrator, assembled from a base 8gent 0.1 plus the modules they have entitlement to. A vertical-domain vessel concatenates a domain-specific module. A compliance-engaged vessel concatenates a compliance module. The base remains 10M params; the tenant-specific orchestrator might be 12-20M.

This becomes a **marketplace primitive** for the control plane (`8gent.app`): expert modules as installable units.

### 2.4 Where this fits in the stack

```
                      USER REQUEST
                           |
                           v
                  +----------------+
                  |  TUI / CLUI    |  apps/tui, apps/clui
                  +----------------+
                           |
                           v
                  +----------------+
                  |  8gent 0.1     |  packages/eight-bdh
                  |  (orchestrator)|  decides: model, agent, tool, budget
                  +----------------+
                     /     |     \
                    v      v      v
            +--------+ +--------+ +--------+
            | eight- | | Claude | | sub-   |
            | 1.0    | | / GPT  | | agents |
            | 14B    | | (cloud)| |        |
            +--------+ +--------+ +--------+
                           |
                           v
                  +----------------+
                  |  G8WAY audit   |  packages/g8way
                  |  (synapse log) |
                  +----------------+
```

8gent 0.1 sits **above** the providers (`packages/providers/`) and **above** the orchestration package's task-dispatcher. It does not replace them; it produces the structured input they consume.

---

## 3. Architecture decisions

### 3.1 Model size

**Decision: start at 10M params, design for graceful growth to 100M.**

Rationale:
- BDH's published scaling at 10M matches GPT-2 small in perplexity terms but with constant-memory inference. For routing-only tasks (short context in, short structured decision out), 10M is plausibly enough.
- 10M trains overnight on a single 4090 or in <24h on Apple Silicon via MLX. Fits the "free and local" budget.
- 100M is the upper bound where local CPU inference is still real-time. Anything bigger and we lose the latency edge over the generalist.

We commit to 10M for **v0.1**. We will only scale to 100M after:
- (a) Phase 1 success metrics are met at 10M, AND
- (b) we have a measured task class where 10M plateaus and 100M improves.

No speculative scaling.

### 3.2 Training approach

**Decision: full pretrain on synthetic orchestration corpus, no fine-tune from a base model.**

Why pretrain not fine-tune:
- BDH is a new architecture; no public pretrained checkpoint is suitable.
- The target distribution (tool-call traces, routing decisions, dispatch graphs) is extremely narrow. We do not need general-language coverage; we need depth in a small slice.
- Pretraining at 10M is cheap enough that we are not saving meaningful compute by warm-starting.

Loss: standard next-token cross-entropy on serialised orchestration traces. Optionally a structured-output head later (Phase 3+).

### 3.3 Inference target

**Decision: ship two inference paths from day one.**

| Path | Runtime | Use |
|---|---|---|
| **Local CPU/Apple-Silicon** | MLX or ONNX | Default for the TUI, lil-eight, dev machines |
| **Vessel (Fly.io daemon)** | Bun + ONNX or FastAPI shim | For `eight-vessel.fly.dev` and tenant vessels |

We do **not** ship a cloud-only path. If someone cannot run 8gent 0.1 locally, they fall back to the existing heuristic router; the harness must still work.

Constant-memory inference is the headline win here. Long-running multi-agent sessions (the kind the WorktreePool runs) currently bloat the orchestrator's context. With BDH the orchestrator's memory footprint is fixed.

### 3.4 Integration with the existing harness

**Decision: new package `packages/eight-bdh/` that the existing dispatcher calls into. No rewrites.**

```
packages/eight-bdh/
  index.ts                  # public API
  client.ts                 # local + remote inference wrappers
  decode.ts                 # logits -> structured Decision
  trace.ts                  # monosemantic activation -> AuditTrace
  trainer/                  # forks pathwaycom/bdh, kept in sync via subtree
  models/                   # weights + tokenizer (gitignored, downloaded on first use)
  prompts/                  # serialisation templates for orchestration tasks
  package.json
  README.md
```

Public API (single entry point):

```ts
export interface OrchestratorInput {
  request: string;
  harnessState: HarnessSnapshot;     // open files, tools, vessels, budget
  policy: PolicyContext;             // G8WAY authority level, deny-list
}

export interface Decision {
  kind: 'model' | 'agent' | 'tool' | 'reject';
  target: string;                    // e.g. 'claude-opus-4-7' or '8TO'
  budget: { tokens: number; ms: number };
  confidence: number;                // 0..1
}

export interface AuditTrace {
  synapseIds: string[];              // monosemantic concept tags fired
  topActivations: { concept: string; weight: number }[];
  reasoningChain: string[];          // human-readable, derived from synapses
}

export async function decide(
  input: OrchestratorInput,
): Promise<{ decision: Decision; trace: AuditTrace }>;
```

Existing callers in `packages/orchestration/task-dispatcher.ts` and `packages/eight/agent.ts` get a single new dependency. The fall-back path (current heuristic) stays intact behind a feature flag `EIGHT_BDH_ROUTER=on|off` (defaults `off` for v0.1, `on` for v0.2+).

### 3.5 Compute strategy and hardware

**Decision: train locally on James's M2 Max for Phase 0 and Phase 1 single-runs. RunPod is a confirmed fallback for hyperparameter sweeps, multi-seed experiments, and any scale-up beyond 10M.**

**Detected local hardware (captured 2026-04-28):**

| Component | Value |
|---|---|
| Chip | Apple M2 Max (Mac14,6) |
| CPU | 12 cores (8 performance + 4 efficiency) |
| GPU | 38 cores, Metal 4 |
| Memory | 96 GB unified |
| OS | macOS 26.5 |

This is more than enough for sub-100M training. The unified-memory model means the full 96 GB is addressable by the GPU with no copy overhead, which exceeds any single consumer NVIDIA card and matches a 4090's compute bandwidth ceiling for the workloads we care about (linear attention, dense matmul).

**Framework choice: PyTorch with MPS backend.**

- BDH upstream is PyTorch. We do not fork the model code in Phase 0.
- MPS is mature for the ops BDH uses. No exotic kernels.
- An MLX port is a Phase 2+ optimisation if we need 2-3x more throughput. Not a Phase 0 blocker.

**Wall-clock estimates (back-of-envelope, replace with measured numbers after Phase 0):**

| Run | Tokens processed | M2 Max (PyTorch+MPS) | RunPod A100 40GB | RunPod H100 80GB |
|---|---|---|---|---|
| Phase 0 hello-world (5M model, 1k examples, 5 epochs) | ~2.5M | **1-2h** | ~10 min | ~5 min |
| Phase 1 single run (10M model, 50k examples, 5 epochs) | ~250M | **8-16h overnight** | ~45 min | ~15 min |
| Phase 1 hyperparam sweep (8 seeds × full run) | ~2B | 3-5 days continuous | ~6h | ~2h |
| Phase 2+ scale-up to 100M (50k examples, 5 epochs) | ~250M | 3-5 days | ~6h | ~2h |

Assumptions: ~10 TFLOPS sustained on M2 Max under MPS (realistic for a small model with linear attention), 150 TFLOPS BF16 on A100, 450 TFLOPS BF16 on H100. Memory headroom is not a constraint at any of these sizes.

**Roadmap implication:**

- **Phase 0 = local only.** 1-2h of compute. Free. Fan noise tolerable.
- **Phase 1 single run = local overnight.** Free. James kicks it off before bed, reads results in the morning.
- **Phase 1 hyperparam sweep = RunPod.** This is the only point where renting compute pays for itself. Sweeping 8 seeds locally is 3-5 days; on an A100 it is 6 hours. The marginal cost of RunPod here buys back days of calendar time once we are tuning seriously.
- **Phase 2 100M scale-up = RunPod.** Local is feasible at 3-5 days but iteration becomes painful. Move to A100 or H100 the moment we commit to 100M.

**Default policy:** stay local until we are bottlenecked on iteration speed, not on first run. Patient training over expensive training, per James's preference.

**Auto-detection tool.** Ship `packages/eight-bdh/scripts/detect-compute.ts` so the harness self-recommends:

```bash
$ bun run packages/eight-bdh/scripts/detect-compute.ts
Local: Apple M2 Max, 38 GPU cores, 96 GB unified, macOS 26.5
Recommended:
  Phase 0 hello-world (5M):  LOCAL  (~1-2h, free)
  Phase 1 single run (10M):  LOCAL  (~overnight, free)
  Phase 1 seed sweep:        RUNPOD (~6h on A100) or LOCAL (~3-5d)
  Phase 2 scale-up (100M):   RUNPOD (~6h on A100)
```

The script reads `system_profiler` on macOS and `nvidia-smi` on Linux. On RunPod-tagged runs it prints the live hourly rate at trigger time so James sees the real cost, not a number frozen in this spec.

**Disk / dataset.** 50k JSONL examples at ~2KB each = ~100MB raw, ~30MB tokenised. Fits in memory. Checkpoints at 10M params in BF16 = ~20MB each. Negligible storage footprint.

### 3.6 Model merging surface

For Phase 4 (tenant modules):

```ts
export async function loadOrchestrator(opts: {
  base: '8gent-0.1.0-bdh-r:10m';
  modules: ModuleId[];               // e.g. ['food-routing-0.1', 'compliance-0.1']
}): Promise<OrchestratorHandle>;
```

Concatenation is BDH-native. We do **not** invent our own merging algorithm. We do invent the `ModuleId` registry, which lives in the control plane (`packages/control-plane/` or its successor).

---

## 4. Training dataset specification

This is the meat. Without a good corpus, the model is a curiosity.

### 4.1 Data shape

Each training example is a serialised `(state, decision, trace)` triple. JSONL on disk, pre-tokenised at training time.

```jsonc
{
  "id": "synth-2026-04-28-00001",
  "state": {
    "request": "rewrite this auth middleware to use the new policy engine",
    "context": {
      "open_files": ["packages/permissions/policy-engine.ts", "src/auth/middleware.ts"],
      "tools_available": ["Read", "Edit", "Bash", "AgentTool"],
      "vessels_available": ["8TO", "8SO"],
      "budget_remaining": { "tokens": 80000, "ms": 600000 },
      "history_summary": "user has been debugging auth for 20 minutes, last attempt failed CI"
    },
    "policy": {
      "authority_level": 3,
      "deny_actions": ["push_to_main"]
    }
  },
  "decision": {
    "kind": "agent",
    "target": "8SO",
    "budget": { "tokens": 12000, "ms": 90000 },
    "confidence": 0.83
  },
  "trace": {
    "concepts_fired": [
      "code-edit",
      "security-sensitive",
      "ci-failed-recently",
      "policy-engine-context",
      "vessel-8SO-fits"
    ],
    "reasoning": [
      "Request mentions auth - security-sensitive",
      "Failed CI in history - escalate to specialist",
      "8SO covers compliance and security",
      "Budget allows agent dispatch"
    ]
  }
}
```

Three things to note:
- `concepts_fired` are **labels we control**. They become the monosemantic synapse targets during training (Section 4.4).
- `reasoning` is for human inspection and curriculum bootstrapping; the model learns to predict `concepts_fired` and `decision`, not the prose.
- Budget and policy are inputs, not outputs. The model must respect them.

### 4.2 Source mix

Five sources, target volume **50k examples for Phase 1** (10k Phase 0 hello world):

| Source | Volume target | How |
|---|---|---|
| **Replay logs** from existing 8gent sessions | 10k | Mine `~/.8gent/sessions/` and `apps/dashboard` events. Each turn becomes a training pair: state at turn-start, decision actually taken, post-hoc concept labels. |
| **Synthetic from frontier models** | 25k | Prompt Claude/GPT with `(state, candidate_decisions)` and ask for the right pick + reasoning. Filter through `packages/eight/scripts/judge.ts` (already wired) for quality gating. |
| **Adversarial / red-team** | 5k | Generate edge cases: budget exhausted, deny-listed action requested, conflicting tools, ambiguous request. Force the model to learn "reject" and "ask for clarification" as first-class outputs. |
| **Curated boardroom traces** | 2k | The Boardroom skill (`.claude/skills/billiondollarboardroom/`) already produces structured deliberation. Repurpose those as multi-step orchestration examples. |
| **Public datasets** | 8k | ToolBench, AgentBench, MetaTool routing tasks. Translate into our format. License-checked, MIT/Apache only. |

**Hard rule:** every example carries a `provenance` field. We ship the provenance graph alongside the model so anyone can audit where the behaviour came from.

### 4.3 Synthetic generation pipeline

This is the only part with non-trivial new code. Spec:

```
scripts/bdh-data/
  collect-replays.ts        # session DB -> JSONL
  generate-synthetic.ts     # prompt frontier model, write JSONL
  generate-adversarial.ts   # rule-based edge case generator
  ingest-public.ts          # ToolBench/AgentBench -> our schema
  judge.ts                  # quality filter (uses Vercel AI SDK as judge per CLAUDE.md rule)
  dedupe.ts                 # near-dup removal via embedding clustering
  split.ts                  # train/val/test 90/5/5 with stratification by `decision.kind`
```

Mandatory rules:
- **AI SDK as judge** for quality filtering. No regex `.includes()` evaluation per CLAUDE.md "AI Judging Rule".
- **No secrets in synthetic data.** The frontier-model prompts and the seeded states must be sanitised. Linter on the pipeline.
- **Reproducible.** Seeds checked into config. Outputs hashed and recorded in `data/manifest.json`.

### 4.4 Concept ontology (monosemantic targets)

For BDH's monosemanticity to be useful, we need a fixed concept vocabulary the model is trained to associate with specific synapses. This is the most opinionated design decision in the spec.

**Phase 1 vocabulary, ~120 concepts in 6 categories:**

| Category | Examples | Approx count |
|---|---|---|
| Task class | `code-edit`, `code-read`, `code-explain`, `debug`, `refactor`, `test-write`, `doc-write`, `review`, `plan`, `research-web`, `research-internal` | ~25 |
| Sensitivity | `security-sensitive`, `auth-touching`, `payment-touching`, `pii-touching`, `prod-touching`, `read-only`, `low-stakes` | ~15 |
| Vessel-fit | `vessel-8EO-fits`, `vessel-8TO-fits`, ... `vessel-8GO-fits`, plus `no-vessel-fits` | ~9 |
| Budget signal | `budget-low-tokens`, `budget-low-time`, `budget-comfortable`, `budget-exhausted` | ~6 |
| Policy signal | `authority-l1`, ... `authority-l5`, `deny-listed-action`, `requires-approval`, `approval-already-granted` | ~12 |
| Provider-fit | `local-sufficient`, `frontier-required`, `claude-best-fit`, `gpt-best-fit`, `tool-call-heavy`, `vision-required`, `long-context-required`, `latency-critical` | ~25 |
| State / history | `recent-failure`, `recent-success`, `loop-suspected`, `compaction-due`, `fresh-session`, `long-session` | ~15 |
| Output kind | `decision-model`, `decision-agent`, `decision-tool`, `decision-reject`, `decision-clarify` | ~5 |
| Reserve / drift | unallocated synapses for emergent concepts (we monitor and label) | ~8 |

The training loss is **single-head, paper-faithful**: standard next-token cross-entropy on serialised orchestration traces. **No concept-BCE supervision.**

Per the BDH paper (arXiv 2509.26507, §"BDH-GPU emergent properties"): "we did not apply any specific training method which would be known to guide the system towards any of the observed emergent properties. (In particular, L1-regularization was disabled.)" Monosemanticity in BDH-GPU is an emergent property of the architecture, not an engineered one.

Boardroom decision (2026-04-28, Option A): we adopt the paper's emergent-monosemanticity approach. The concept ontology in section 4.4 above serves as a **post-training probe vocabulary**, not as a supervised training target. After Phase 0 / Phase 1 training:
1. Run the probe runner against the gold set; for each synapse position, identify the concept (if any) it most reliably co-fires with.
2. Label CONCEPT_VOCAB positions descriptively, post-hoc, based on probe evidence. Reserve slots stay reserve until probes name them.
3. Update `ONTOLOGY_VERSION` per the drift policy in `packages/eight-bdh/ONTOLOGY-RATIONALE.md`.

Re-evaluation: if Phase 1 probes show <50% per-concept synapse precision (i.e. emergent monosemanticity is too noisy to be useful as audit evidence), we reopen the supervised-concept-head decision at L5 boardroom. Until then, paper-faithful.

### 4.4b Decision target naming (Phase 1 amendment, 2026-04-28)

Phase 0 corpus used the internal officer codes (`8EO`, `8TO`, `8PO`, `8DO`, `8SO`, `8CO`, `8MO`, `8GO`) as the `decision.target` value when `decision.kind == "agent"`. That was operationally convenient because the harness already uses these codes for vessel addressing.

It is **wrong for the model.** The codes are 8GI-specific shorthand. End users, external labellers, Pathway, anyone outside the inner circle reads them as opaque symbols. A model trained from scratch on a byte-level vocab learns them as opaque too: there is no semantic structure to leverage.

**Phase 1 amendment:** the corpus uses **role-name targets** as the user-visible string, with officer codes resolved to vessel addresses at dispatch time inside the harness.

| Decision target (model output) | Harness vessel (runtime resolution) |
|---|---|
| `Executive` | `8EO` |
| `Technical` | `8TO` |
| `Product` | `8PO` |
| `Design` | `8DO` |
| `Security` | `8SO` |
| `Community` | `8CO` |
| `Marketing` | `8MO` |
| `Governance` | `8GO` |

The lookup table lives in `packages/orchestration/role-config.ts` (single source). The dispatcher consumes the model's string output, resolves to a vessel code, dispatches.

**Trace concepts** carry both forms (e.g. `vessel-security-fits` AND `vessel-8SO-fits` as ontology synonyms) so audit records are human-readable and the dispatcher can match either.

**Why this is right:**
- Labellers grading the gold set read role names without translating; expected to lift Cohen's kappa.
- Audit logs are readable without an officer-code glossary.
- Externalisation: when 8gent 0.1 is described publicly or to Pathway, the model output uses common-knowledge words.
- Future-proofing: if we add a role that does not have an officer (e.g. `Data`, `Infra`), role names accommodate it.

**Why we did not retrofit Phase 0:** Phase 0 is already trained. The retraining cost (~2h on M2 Max) is real but the Phase 0 model is a heartbeat artifact that is not measured for routing quality, so the labels never mattered. Phase 1 corpus generator picks up the new schema; Phase 0 corpus stays as-is for reproducibility.

**Authority:** Chair (James Spalding) decision 2026-04-28, informed by the question of whether the model should learn 8GI-internal codes or common-knowledge role names. Boardroom may reverse at L5 if Phase 1 evidence shows role-name targets hurt the kappa or accuracy gates.

### 4.5 What we are NOT including in the corpus (Phase 0+1)

Explicit non-goals so the corpus stays focused:
- **General code generation.** That is `eight-1.0`'s job.
- **Long-form prose.** Orchestrator outputs are structured, not flowing.
- **Multi-language NL.** English only for v0.1. i18n is Phase 5+.
- **Vision/multimodal.** Out of scope for the orchestrator. The decision can call a vision-capable downstream model; the orchestrator itself stays text.
- **Tool-use execution traces.** We learn to dispatch tools, not to execute their internals.

---

## 5. Phased roadmap

NOW / NEXT / LATER per CLAUDE.md (no Q1/Q2/Q3).

### Phase 0 - Hello World (NOW, 1 week)

**Goal:** Prove BDH trains on our infra and emits a sane decision on a toy corpus.

- [ ] Fork `pathwaycom/bdh` into `packages/eight-bdh/trainer/` via git subtree.
- [ ] Stand up MLX or PyTorch training script on James's local rig.
- [ ] Generate 1k synthetic examples (frontier-model only, no replays yet).
- [ ] Train a 5M param model on M2 Max via PyTorch+MPS (~1-2h). Sanity check: it predicts the right `decision.kind` 70%+ on a 100-example held-out set.
- [ ] Wire a CLI: `bun run packages/eight-bdh/cli.ts decide --request "..."`. Pure inference, no harness integration.
- [ ] Benchmark inference latency on M-series Mac. Target: <50ms per decision at 5M.

**Exit gate:** the demo CLI returns a parseable decision plus 3+ activated concepts. Latency under 100ms.

### Phase 1 - Useful Router (NEXT, 4-6 weeks)

**Goal:** A 10M model trained on the full 50k corpus that outperforms the current heuristic router on a measurable benchmark.

- [ ] Build the synthetic data pipeline (Section 4.3). Get to 50k examples with provenance.
- [ ] Lock the concept ontology (Section 4.4). Tag the corpus.
- [ ] Train 10M model with two-head loss. Multiple seeds.
- [ ] Build evaluation harness. Three benchmarks:
  1. **Routing accuracy** vs ground truth on the 5k held-out test set.
  2. **Cost-quality frontier** on `bun run benchmark:v2` with 8gent 0.1 routing vs heuristic routing.
  3. **G8WAY audit completeness** - every decision has at least 2 fired concepts and a reasoning chain that a human grader rates "useful" >70% of the time.
- [ ] Integrate into `packages/orchestration/task-dispatcher.ts` behind `EIGHT_BDH_ROUTER=on` feature flag.
- [ ] Internal dogfood for two weeks before any external opt-in.

**Exit gates (all must be met):**
- Routing accuracy: ≥ heuristic + 10pp on the held-out set.
- Cost-quality: same or better task success on benchmark, with ≥20% fewer frontier-model calls.
- Latency: p95 ≤ 80ms on local inference.
- Audit: 100% of decisions emit a non-empty trace; 70%+ rated useful by human review on a 200-decision sample.

### Phase 2 - Sovereign Default (LATER, 8-12 weeks after Phase 1)

**Goal:** 8gent 0.1 becomes the **default** orchestrator. Heuristic router stays as fallback only.

- [ ] Promote `EIGHT_BDH_ROUTER=on` to default in v0.13.
- [ ] Ship pre-built weights via `npm install` post-install hook (gated on local capability detection).
- [ ] Vessel-side inference path on `eight-vessel.fly.dev`.
- [ ] G8WAY integration: every Level 3+ decision must include the audit trace. Rejections logged to `packages/g8way/events`.
- [ ] Public spec doc on 8gent.world describing the model, the corpus provenance, and the audit format.

### Phase 3 - Domain Modules (LATER)

**Goal:** Validate concatenation in production. Three pilot modules.

Pilot modules (in priority order):
1. **`vertical-domain-0.1`** for an internal vertical project - domain-specific routing classes (recipe / supplier / compliance / customer-style splits).
2. **`compliance-0.1`** for compliance-focused engagements - regulatory framework routing (GDPR / SOC2 / ISO).
3. **`gamedev-0.1`** for an internal games project - world-state / agent-behaviour / rendering routing classes.

Each module is trained on ~5k domain-specific examples, concatenated to 8gent 0.1, evaluated on a domain benchmark. Module sizes target 1-2M each.

**Exit gate:** at least one pilot module ships to a real tenant with measured task-success uplift over base 8gent 0.1.

### Phase 4 - Module Marketplace (LATER, post-Phase 3)

**Goal:** Modules become an installable primitive in the control plane.

- [ ] `ModuleId` registry in the control plane.
- [ ] Signed-module verification (G8WAY).
- [ ] Tenant entitlement check at vessel boot.
- [ ] `bun 8gent module install <id>` CLI surface.

This is the commercial layer. We do not design the pricing or marketplace UX in this spec. That belongs to the control-plane PRD.

### Phase 5 - 8gent 0.2 (LATER)

Open questions to resolve before committing to 0.2:

- Multilingual orchestration (Portuguese first, partner-driven prioritisation).
- Multimodal awareness (does the orchestrator need to see a screenshot to route well?).
- Continuous learning from production (online updates vs nightly retrain).
- 100M scale-up if the 10M plateau is real.

We do not commit to any of these now. Ship 0.1 first.

---

## 6. Integration points (concrete files)

| File | Change |
|---|---|
| `packages/eight-bdh/` | NEW. Per Section 3.4. |
| `packages/orchestration/task-dispatcher.ts` | Add BDH path, feature-flagged. ~30 LOC. |
| `packages/orchestration/role-config.ts` | Schema add: `bdh_module_ids?: string[]` per role. |
| `packages/eight/agent.ts` | Optional: `decide()` call before tool selection when `EIGHT_BDH_ROUTER=on`. |
| `packages/g8way/audit.ts` (new or extend existing) | Persist `AuditTrace` to event log. |
| `packages/providers/index.ts` | No change. The model is internal, not a provider. |
| `bin/8gent.ts` | Version bump to 0.13.0 when Phase 2 lands. |
| `CHANGELOG.md` | Entry per phase. |
| `docs/MODELS.md` | Update with the `8gent-*` family. |

Phase 0 touches **two new files** and **zero existing files**. Phase 1 touches roughly six files. We are well under the "minimise blast radius" threshold.

---

## 7. Governance perspective (8GO / G8WAY)

This is where 8gent 0.1 stops being a model and starts being **part of the constitution**.

### 7.1 Auditability as a constitutional property

The G8WAY package (`packages/g8way/`) is built on the principle that high-authority decisions must carry justification. Today, justifications are mostly post-hoc - generalist models are asked "why did you decide that?" after the fact, and they confabulate.

8gent 0.1's monosemantic synapses change the contract. The decision **is** the trace. There is no separate "explain yourself" step. This is the difference between:

- "After deciding to escalate, the model produced a plausible-sounding paragraph." (current)
- "These 5 synapses fired with these weights; the synapses correspond to these 5 known concepts; the decision is the deterministic output of those activations." (8gent 0.1)

For the Constitution this matters because audit logs become **evidence** rather than testimony.

### 7.2 Authority levels and the orchestrator

G8WAY defines five authority levels (per `project_g8way_governance.md`). 8gent 0.1's relationship to each:

| Level | Who | 8gent 0.1's role |
|---|---|---|
| L0 - Read-only | All vessels | Orchestrator may route freely; no approval needed. |
| L1 - Local writes | Most vessels | Orchestrator may route; trace logged. |
| L2 - Push to feature branch | Engineering vessels | Orchestrator routes, trace logged, post-hoc audit. |
| L3 - Push to main / merge PR | Senior vessels | Orchestrator must emit a trace with a confidence ≥ threshold AND non-empty fired concepts; G8WAY enforces. |
| L4 - Production deploy | Founders + 8EO | Orchestrator advises only; human-in-the-loop. Trace required for the record. |
| L5 - Constitutional change | Boardroom | Orchestrator does not decide. Boardroom decides. Trace optional. |

Encoded in `packages/g8way/policy.yaml` (or wherever the policy engine reads from) as a hard precondition: "for actions at L3+, an `AuditTrace` with `synapseIds.length >= 2` must be present in the request envelope."

### 7.3 Tenant isolation and concatenated modules

When tenant modules concatenate onto the base, G8WAY treats them as **labelled extensions** of the base orchestrator. Properties:

- Modules are signed (Phase 4). G8WAY verifies the signature at vessel boot.
- Module activations are tagged in the audit trace (`synapseIds` get a module-prefix when fired from a tenant module).
- A tenant cannot install a module that grants their orchestrator authority above the tenant's own level. The control plane enforces this at install time; G8WAY enforces it at runtime.

This gives us **defence in depth**: a malicious or misbehaving module cannot quietly elevate routing decisions above the tenant's authority, because G8WAY sees the module-tagged synapses and applies the cap.

### 7.4 Constitutional alignment summary

| Principle | How 8gent 0.1 expresses it |
|---|---|
| 1. Design first | The orchestrator is a designed surface (this spec), not an emergent behaviour. |
| 2. Free and local | 10M model on local hardware. No API key required. |
| 3. Self-evolving | Every session's decisions feed Phase 1+ retraining via the `personal-collector.ts` pipeline. |
| 4. Hyper-personal | Tenant modules concatenated onto the base. |
| 5. Accessible | Same TTS/voice surfaces as the rest of the harness; no new accessibility regression. |
| 6. Orchestrate by default | This is literally the orchestrator. |
| 7. Reduce friction, increase truth | Audit trace is the truth. |
| 8. Work speaks for itself | Performance against benchmarks, not narrative. |

---

## 8. Risks and how we mitigate

| Risk | Mitigation |
|---|---|
| BDH 10M cannot learn the routing distribution | Phase 0 hello-world is a fast-fail check. If it cannot hit 70% on toy data, we abandon and revisit at 50M before going further. |
| Synthetic data poisoning the model with frontier-model biases | AI SDK judge filter; adversarial set forces non-trivial behaviour; 10k real replay examples anchor it to actual usage. |
| Monosemanticity is "true in the paper, fragile in practice" | Two-head loss with explicit concept supervision, not just hoping monosemanticity emerges. Audit gate in Phase 1 measures this directly (70% useful-rated traces). |
| Concatenation breaks at our scale | Phase 3 is gated on actually proving concatenation works. We do not promise marketplace before then. |
| Model becomes a single point of failure for the harness | Heuristic router stays as fallback indefinitely. Feature flag stays in the codebase. The harness must work with `EIGHT_BDH_ROUTER=off`. |
| Training data leaks PII or proprietary code | Sanitisation linter on the pipeline; provenance graph; no replays from sessions tagged sensitive; legal review of any module trained on tenant data. |
| Module marketplace becomes a regulatory surface (we are essentially running a model registry) | Phase 4 includes signed modules, capability caps, and entitlement checks. Solomon (8GO) reviews before any external module ships. |

---

## 9. Success metrics (consolidated)

Phase 0 ship gate:
- [ ] Trains end-to-end on local infra.
- [ ] 70%+ decision-kind accuracy on 100-example toy holdout.
- [ ] <100ms inference latency on M-series.

Phase 1 ship gate (all required):
- [ ] +10pp routing accuracy vs heuristic baseline on 5k held-out test set.
- [ ] ≥20% fewer frontier-model calls on `bun run benchmark:v2` with same or better task success rate.
- [ ] p95 inference latency ≤80ms locally.
- [ ] 100% of decisions emit non-empty audit trace.
- [ ] 70%+ of traces rated "useful" by human grader on 200-decision sample.

Phase 2 ship gate:
- [ ] Two weeks of internal dogfood with no P0/P1 regressions.
- [ ] G8WAY integration verified end-to-end on L3 decisions.
- [ ] Public spec doc published on 8gent.world.

Phase 3 ship gate:
- [ ] At least one tenant module deployed to a real tenant.
- [ ] Domain-benchmark uplift over base measurable and >5pp.

We do not measure "lines of code shipped" or "features added". Routing quality, audit quality, and tenant impact only.

---

## 10. Open questions for the boardroom

These need decisions before Phase 1 starts:

1. ~~**Where does training compute run?**~~ **Resolved (2026-04-28):** Local M2 Max for Phase 0 + Phase 1 single runs (free, overnight). RunPod confirmed available for hyperparameter sweeps and Phase 2 scale-up. See §3.5 for the hardware breakdown and the per-phase recommendation.
2. **Who owns the concept ontology?** 8GO (Solomon) is the natural owner of an audit-shaped vocabulary. Confirm.
3. **Provenance graph storage.** Per-example provenance balloons fast. SQLite or Parquet? 8TO call.
4. **Module signing key custody.** Phase 4 problem, but the answer affects Phase 2's audit format. 8SO (Karen) call.
5. **Public release of 8gent 0.1 weights?** MIT-licensed BDH base argues for yes; the value is in the corpus, not the weights. 8MO + 8GO joint call.
6. **Naming sanity.** `8gent-0.1.0-bdh-r:10m` is correct under our model SemVer rule but ugly in chat. Acceptable internal id; user-facing string is `8gent 0.1`. Confirm.

---

## 11. What this spec does not contain

For honesty:

- **No training loss curves.** None exist yet.
- **No latency numbers from our infra.** Phase 0 produces them.
- **No tenant commitments.** Three candidate Phase 3 module hosts identified privately; none have been asked yet.
- **No commercial pricing.** Module marketplace pricing is a control-plane concern, not a model-spec concern.
- **No legal review of corpus sources.** Phase 1 prerequisite.

This is a directional spec, not a schedule. The phase gates are the contract.

---

## Appendix A - Why not just fine-tune Llama / Qwen / Gemma?

Worth answering directly because it will come up.

A small fine-tuned generalist (Qwen 0.5B, Gemma 2B, etc.) would solve the "cheap routing" problem. It would not solve:

1. **Auditability.** Softmax attention plus generalist pretraining gives us a black box. We can probe it post-hoc but cannot guarantee monosemantic features without retraining from scratch with that objective.
2. **Constant-memory inference.** Quadratic attention forces context limits even in small models. Long agent sessions degrade.
3. **Concatenation.** Generalist fine-tunes do not merge cleanly. Adapter stacking (LoRA composition) approximates it but with nontrivial drift.

The orchestrator is the **one** place in the harness where these three properties matter together. Everywhere else (code-writing, prose, debugging) a fine-tuned generalist is the right tool, and we already have one in `eight-1.0-q3:14b`.

8gent 0.1 is a deliberate architecture bet for one specific role.

---

## Appendix B - Relationship to `packages/kernel/` (RL fine-tuning)

The existing kernel package is a GRPO/RLHF pipeline targeted at improving the **generalist** (`eight-1.0`). It is off by default per CLAUDE.md.

8gent 0.1 is a **separate** training pipeline:

| Aspect | `packages/kernel/` (existing) | `packages/eight-bdh/trainer/` (new) |
|---|---|---|
| Target model | `eight-1.0-*` generalist | `8gent-0.X-bdh-*` orchestrator |
| Algorithm | GRPO with PRM judge | Standard NTP + concept-head BCE |
| Cadence | Continuous, online | Batch, offline |
| Status | Specified, off | Not yet built (Phase 0) |

They share the `judge.ts` quality-filter abstraction and the `personal-collector.ts` data hooks. They do **not** share weights, tokenizers, or training infra.

---

**End of spec.**

Next action requires 8EO sign-off on the Phase 0 budget and 8GO sign-off on the concept ontology owner. Default action if neither responds in 7 days: 8EO proceeds with Phase 0 self-funded; 8GO inherits ontology ownership by silent assent.
