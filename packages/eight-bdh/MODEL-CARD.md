# Model Card: 8gent-0.1.0-bdh-r:10m

> **Status: TARGET model card. No weights exist yet.**
>
> This is a *desired-state* model card written before training begins. Every
> training run is judged against this card. The AutoResearch HyperAgent loop
> in `packages/self-autonomy/` iterates corpus and hyperparameters until
> measured reality matches the targets below, then we ship.
>
> Boardroom-ratified 2026-04-28. Spec: `docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md`.

---

## 1. Identity

| Field | Value |
|---|---|
| Family | `8gent` |
| Version | `0.1.0` |
| Architecture | BDH (Baby Dragon Hatchling, Pathway, MIT). arXiv 2509.26507. |
| Architecture deviations from paper | None. Training method deviation: NONE under Option A (paper-faithful, single-head next-token CE). |
| Role | Routing / orchestration (`r`) |
| Parameters | 10M (Phase 1 target). Phase 0 trains a 5M proxy as a heartbeat check; **5M is below the paper's documented 10M-1B scaling range**, so Phase 0 success says "rig works", not "model is good". |
| License (weights) | Apache 2.0 |
| License (corpus manifest) | Apache 2.0 |
| Canonical id | `8gent-0.1.0-bdh-r:10m` |
| User-facing name | 8gent 0.1 |
| Repository | `github.com/8gi-foundation/8gent-code/packages/eight-bdh` |

## 2. Intended use

Routing and dispatch decisions inside the 8gent harness. Given a request plus
harness state, decide:
- Which model to invoke (local generalist, frontier, specialist)
- Which agent / vessel to dispatch (8EO/8TO/8PO/8DO/8SO/8CO/8MO/8GO)
- Which tool to call
- What budget to allocate (tokens, ms)
- When to reject or ask for clarification

Every decision emits an `AuditTrace` with fired-synapse concept ids that
G8WAY persists as evidence per spec section 7.1.

## 3. Out of scope

- General code generation. `eight-1.0-q3:14b` does that.
- Long-form prose, documentation generation, chat replies.
- Multilingual NL. English only for v0.1.
- Vision and multimodal inputs. The decision can dispatch to a vision-capable
  downstream model; the orchestrator itself stays text.
- Tool internals. We learn to dispatch tools, not to execute them.

## 4. Performance targets (THE RUBRIC)

Every target is measured against the **200-example dual-labeled gold set**
(see Data card section 6) with **Cohen's kappa >= 0.7** between labelers
before the gold set is admitted as ground truth.

### 4.1 Routing accuracy

| Metric | Target | Measurement |
|---|---|---|
| Decision-kind F1 (model/agent/tool/reject/clarify) | >= heuristic baseline + 10pp | Gold set holdout (50 examples) |
| Per-kind precision | >= 0.80 each | Gold set holdout |
| Per-kind recall | >= 0.75 each | Gold set holdout |

The heuristic baseline router is a deliverable of the eval harness work
(packages/eight-bdh/eval/baseline-heuristic.ts, ~200 LOC). "+10pp vs heuristic"
is unfalsifiable without it.

### 4.2 Cost-quality frontier

| Metric | Target | Measurement |
|---|---|---|
| Frontier-model call rate vs heuristic on `bun run benchmark:v2` | -20% or more | benchmark:v2 with `EIGHT_BDH_ROUTER=on` vs `=off` |
| Task success rate on benchmark:v2 | >= heuristic | Same |

### 4.3 Latency

| Percentile | Target | Hardware |
|---|---|---|
| p50 | <= 30ms | M2 Max, MPS |
| p95 | <= 80ms | M2 Max, MPS |
| p99 | <= 150ms | M2 Max, MPS |

### 4.4 Auditability (the moat)

Per spec §4.4 Option A: training is paper-faithful (single-head next-token CE,
no concept-BCE supervision). Monosemanticity is emergent. The ontology is a
post-training probe vocabulary; concept labels at each synapse position are
**descriptive, not prescriptive**.

| Metric | Target | Measurement |
|---|---|---|
| Decisions emitting non-empty AuditTrace | 100% | Runtime |
| Traces rated "useful" by human grader (5-point rubric, useful = 4 of 5) | >= 70% | 200-decision sample, monthly |
| Per-concept synapse precision (post-training probe) | >= 0.80 each, no labelled concept below 0.50 | 30-example probe per concept, every checkpoint |
| Reserve-slot promotion rate | <= 20% per ontology MINOR bump (most positions retain hypothesis labels) | Probe runner, every checkpoint |
| Cohen's kappa between two labelers on gold set | >= 0.70 | Pre-training |

**Re-evaluation gate.** If Phase 1 probes show <50% per-concept precision
across the board, the boardroom reopens Option B (supervised concept head)
at L5. Until that signal exists, we follow the paper.

The 5-point usefulness rubric:
1. >= 2 concepts fired
2. Fired concepts correspond to features any human would identify in the input
3. `topActivations` ranking reflects importance
4. `reasoningChain` is readable English
5. Removing any single fired concept changes the decision interpretation

### 4.5 Sovereignty (corpus provenance)

| Source | Floor | Ceiling | Notes |
|---|---|---|---|
| Closed-weight teacher (Anthropic / OpenAI / Gemini / Apple Foundation) | **0%** | **0%** | TOS-binding for Apache 2.0 release |
| Open-weight synthetic (verified license-clean teachers; see §6.2) | 0% | 30% | Three sources for diversity, two licences |
| Real-session replays (`~/.8gent/sessions/`, scrubbed + k-anonymized) | 30% | n/a | k >= 5 on quasi-identifier tuples |
| Adversarial / red-team (rule-based) | 15% | n/a | Edge cases, not Claude-shaped surprises |
| Boardroom traces (multi-officer deliberations) | 10% | n/a | High-quality, low-volume; upweighted in training |
| Public benches (ToolBench, AgentBench, license-checked) | 10% | 20% | License confirmed per dataset |
| Llama (any version) | **0%** | **0%** | 3.0-3.2 prohibit training other LLMs; 3.3+ requires "Llama" prefix in derivative model name, which conflicts with our canonical id |

CI gate: `packages/eight-bdh/scripts/split.ts` refuses to emit a corpus whose
provenance ratios drift outside these bounds. Ratios are recorded in
`data/manifest.json` with a SHA-256 hash; mismatches at training time are a
hard fail.

## 5. Architectural commitments

### 5.1 Constant-memory inference

BDH's linear attention removes the quadratic context-length penalty. Memory
footprint is fixed regardless of session length. Long multi-agent runs in the
WorktreePool do not bloat the orchestrator's working set.

### 5.2 Effective context = retrieved memory + git history (the "infinite scale" path)

The orchestrator's input context window is small by design. Effective context
is constructed at decision time by retrieval, not by stuffing tokens:

| Layer | Source | Retrieval mechanism |
|---|---|---|
| Working memory | `packages/memory/store.ts` (SQLite + FTS5) | Keyword search at decision time, top-5 facts injected |
| Session memory | `~/.8gent/sessions/<session>.json` | Last N turns summarized into the request |
| Long-term memory | Git history of the user's repo + 8gent state | Semantic search over commit messages and diffs (Phase 2) |
| Boardroom memory | Stored deliberations in `data/boardroom/` | Officer-tagged retrieval (Phase 3+) |

The model itself never sees the full memory store. It sees a top-K retrieval
plus the current request. This is the path to "infinite scale" perception
without infinite parameters.

### 5.3 Git as persistence (the "infinite memory" path)

Every session-end auto-commits to a tracked working branch. Every experiment
branches. Every checkpoint signs. Three properties follow:

1. **No work lost.** Crash, kernel panic, power loss: the last auto-commit is
   the recovery point.
2. **Every decision replayable.** The audit log entry is paired with the git
   ref of the working tree at decision time. Reviewers can `git checkout` the
   exact state.
3. **Effective memory is the entire history.** Combined with semantic search
   over commits, the working set is bounded by disk, not by RAM.

The harness owns this discipline. The orchestrator consumes its outputs
(retrieved facts, replayable refs) but does not orchestrate the git itself.

### 5.4 Modular intelligence (concatenation, Phase 4+)

Tenant-specific expert modules concatenate onto the base. Module sizes
target 1-2M params each. Combined orchestrator stays under 20M for a
fully-loaded tenant vessel. Marketplace primitive in `packages/control-plane/`.

## 6. Data card

### 6.1 Corpus volume

| Phase | Volume | Purpose |
|---|---|---|
| Phase 0 | 1k examples | Heartbeat check; rig works |
| Phase 1 | 50k examples | Production model |
| Phase 2 | 100k+ | Scale-up; tenant module training |

### 6.2 Provenance manifest and verified open-weight teachers

Every example carries a `provenance` field with `source`, `model_used` (if
synthetic), `seed`, `created_at`, `notes`. Manifest hashed and recorded in
`data/manifest.json` per training run. Published alongside released weights.

**Approved open-weight teachers (Phase 1):**

| Model | Version pin | Licence | Distillation permitted? | Channel | Local availability |
|---|---|---|---|---|---|
| Qwen 3.6 27B | `qwen3.6:27b` (Ollama tag) | Apache 2.0 | Yes, no constraints | Ollama (local) | Already pulled on M2 Max as of 2026-04-28 |
| Mistral 7B | `mistral:7b` (Ollama tag) | Apache 2.0 | Yes, no constraints | Ollama (local) | Pull required: `ollama pull mistral:7b` |
| DeepSeek-R1 32B | `deepseek-r1:32b` (Ollama tag) **or** `deepseek-v4-flash` (DeepSeek API) | MIT (model and code); license explicitly permits distillation | Yes, explicit | Ollama (local, slower) **or** DeepSeek API (faster, paid) | Pull required for local: `ollama pull deepseek-r1:32b` |

Three sources, two licences (Apache 2.0 + MIT). Volume distributed
roughly equally across teachers to avoid single-teacher bias.

**Phase 0 first run** (1k examples, heartbeat check): single-teacher OK
since no quality claim is made. Default to Qwen 3.6 27B (already pulled).
Mistral and DeepSeek-R1 pulls deferred to Phase 1.

**Excluded teachers (with reasons):**

| Model | Reason |
|---|---|
| Llama 3.0-3.2 | License prohibits using outputs to train other AI models |
| Llama 3.3+ | License permits distillation but requires "Llama" prefix in derivative model name; conflicts with canonical id `8gent-0.1.0-bdh-r:10m` |
| Claude / GPT / Gemini | Closed-weight, TOS prohibits training competing models on outputs |
| Apple Foundation | Closed proprietary, on-device licence does not authorise distillation into a publicly-released model |

### 6.3 Sanitisation

- PII regex scrub (`packages/eight-bdh/scripts/_shared.ts`)
- k-anonymity check on quasi-identifier tuples (k >= 5; new in eval-harness work)
- Manual review of 100% of replay examples before inclusion at Phase 0 scale
- Sensitive-session tag is opt-in, not opt-out (8SO ruling)
- COPPA-compatible age-tagging in provenance (Phase 0 forward; mandatory for any
  8gent Jr replay inclusion)

### 6.4 Gold set custody

200 dual-labeled examples. Stored in `packages/eight-bdh/eval/gold/` under git.
Encrypted-at-rest is **deferred** to a follow-up policy decision (8SO + 8GO).
Kappa measurement, calibration set, honorarium tracking documented in
`packages/eight-bdh/eval/LABELING-PROTOCOL.md` (eval-harness deliverable).

## 7. Audit and governance

The trace is the decision per spec section 7.1. Concrete contract:

- Activations vector positions map 1:1 to `CONCEPT_VOCAB` in
  `packages/eight-bdh/ontology.ts`.
- `ONTOLOGY_HASH()` is recorded at training time and at inference time. A
  mismatch is a hard fail; the runtime refuses to emit a decision rather than
  serve one whose synapse map cannot be trusted.
- L3+ G8WAY decisions require `synapseIds.length >= 2` and
  `topActivations.length >= 1` (enforced in `packages/eight-bdh/audit.ts`).
- L5 (constitutional) decisions are reserved for the boardroom; the
  orchestrator never decides at L5.
- Rubric ratification (this document) is itself an L5 action. Future
  amendments require boardroom deliberation per `BarbershopBoardroom` skill or
  successor protocol.

## 8. Limitations

- **Phase 0 is hello-world.** 5M params on 1k examples. Heartbeat check, not a
  quality bar. Do not draw conclusions about Phase 1 from Phase 0.
- **5M is below the BDH paper's documented 10M-1B scaling range.** Pathway
  has not published evidence that BDH-GPU learns at 5M. Phase 0 may fail to
  hit even the heartbeat target (loss curve descends, parseable Decision out)
  for architectural reasons unrelated to corpus quality. If that happens, we
  jump straight to 10M for the next run rather than tuning at 5M.
- **Monosemanticity is emergent, not engineered.** Per spec section 4.4
  Option A. The ontology is a probe vocabulary, not a training target.
  Per-concept precision is measured post-training; if probes show <50%
  precision across the board, we reopen the supervised-concept-head decision
  at L5 boardroom (re-evaluation gate in section 4.4).
- **Routing accuracy targets are gated on the eval harness.** Without the
  200-example dual-labeled gold set + heuristic baseline, every target in
  section 4.1 is unfalsifiable.
- **Single labeler bias on the non-gold corpus.** Volume slices outside the
  gold set are James-labeled. Documented bias, not eliminated.
- **English only.** Multilingual orchestration is Phase 5+.
- **No real-time online learning.** Every model release is a discrete batch
  retrain; the GRPO/RLHF kernel in `packages/kernel/` is a separate pipeline.

## 9. Ethical considerations

- **TOS compliance.** Zero closed-weight teacher contamination. Open-weight
  teachers used under their published licenses; license check in CI.
- **PII.** Replay scrub plus k-anonymity. Sensitive sessions opt-in only.
- **Children's data.** COPPA-compatible age-tagging in provenance. 8gent Jr
  replays gated on parental consent before any inclusion.
- **EU users.** GDPR right-to-erasure honored: a session removed from disk is
  removed from the next training run; weights from prior runs continue under
  their existing manifest until the next major version bump.
- **Adversarial prompt injection.** Synthetic generator prompts are pinned in
  signed commits. Two-officer review (8SO + 8TO) on every prompt-template
  diff. Adversarial probe set runs before each training run.
- **Model laundering risk.** Mitigated by the closed-weight cap at 0%.
  Re-evaluated at every release.

## 10. AutoResearch loop wiring

The AutoResearch HyperAgent loop in `packages/self-autonomy/` reads this card
as a structured target. Each iteration:

1. Run training with the current corpus + hyperparam config.
2. Run the eval harness against the gold set.
3. Compare measured numbers to section 4 targets.
4. Propose the smallest corpus / hyperparam change that closes the largest
   gap, score it via judge.
5. Append the proposal + measured baseline to a journal.
6. If a target gate is met, mark it green in `STATUS.md`. If all green,
   recommend ship.

The loop runs overnight on James's M2 Max. RunPod kicks in for Phase 2 scale-up
and seed sweeps per spec section 3.5. The loop never modifies this card; only
James (Board Chair) and an L5 boardroom decision can amend the targets.

## 11. Status snapshot (updated by the loop)

| Target | Status | Last measured |
|---|---|---|
| Routing F1 vs heuristic | Pending eval harness | n/a |
| Frontier-call reduction | Pending baseline | n/a |
| p95 latency on M2 Max | Pending Phase 0 first run | n/a |
| Trace usefulness (5-point rubric) | Pending labeler recruitment | n/a |
| Per-concept precision | Pending probe runner | n/a |
| Cohen's kappa on gold set | Pending second labeler | n/a |
| Closed-weight contamination | 0% (architectural commitment) | 2026-04-28 |
| ONTOLOGY_HASH | `e591cf457ef8c018...` | 2026-04-28 |

## 12. Versioning

Model SemVer per `project_model_versioning.md`:
- PATCH: hyperparam tweaks at unchanged corpus and ontology. Same weights,
  retrained for stability.
- MINOR: corpus volume change, ontology reserve-slot relabel. Old checkpoints
  still load with a warning.
- MAJOR: ontology reorder, architecture change, corpus mix outside the
  bounds in section 4.5. Hard break.

Card amendments follow the same SemVer. This card is `0.1.0-target`. Any
measured numbers are appended to section 11; the targets in sections 1-10
do not change without an L5 boardroom decision.

---

End of card.
