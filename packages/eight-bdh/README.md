# `@8gent/eight-bdh`

The 8gent 0.1 BDH orchestrator. A small, specialised reasoning core whose job is dispatch: read the user's request plus harness state, decide which model / agent / tool to route to, and emit an auditable activation trace. It is an orchestrator, not a generalist. Generalist work continues to flow through `eight-1.0-q3:14b` or frontier providers.

## Status

Phase 0 scaffold. No weights. No trained model. The public functions `decide()` and `loadOrchestrator()` throw with explicit "not implemented yet" messages. The CLI's `decide` subcommand returns a stub `clarify` decision so callers fail closed. Inference clients (`LocalClient`, `VesselClient`) throw the same way. This package exists today to lock the type contract and the public surface; weights and inference paths land in Phase 1+.

Spec: `docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md` §3.4 (package layout), §5 (phase gates), §11 (what this spec does not contain).

## Why BDH

Three properties that map cleanly to 8GI principles (spec §1):

- **Linear attention, constant-memory inference.** Runs on CPU or modest GPU. No VRAM blowup with context length. Free and local by default.
- **Monosemantic synapses.** Each weight maps to one feature, so the routing decision and the reasoning trace are the same artifact. G8WAY auditability is structural, not bolted on.
- **Concatenative model merging.** Tenant-specific expert modules attach to the base without retraining or fine-tune drift. The Phase 4 marketplace primitive.

## Public surface

All shapes live in `types.ts`. Do not redefine them anywhere else.

| Symbol | Source | One-line summary |
|---|---|---|
| `decide(input)` | `index.ts` | Run an orchestration decision. Throws in Phase 0 (no weights). |
| `loadOrchestrator(opts)` | `index.ts` | Concatenate base + tenant modules. Throws in Phase 0 (Phase 4 deliverable). |
| `decode(bytes)` | `decode.ts` | Parse the byte-stream `Decision` head emitted by the model. |
| `extractTrace(activations, conceptIds)` | `decode.ts` | Map a concept-head activation vector to an `AuditTrace`. |
| `LocalClient` | `client.ts` | Subprocess or HTTP shim into a local Python inference server. Throws in Phase 0. |
| `VesselClient` | `client.ts` | WebSocket / HTTP into `eight-vessel.fly.dev`. Throws in Phase 0. |
| `BdhConfig`, `PHASE_0_5M_CONFIG`, `PHASE_1_10M_CONFIG` | `types.ts` | Model architecture constants. Mirrored into `trainer/configs/*.json`. |
| `OrchestratorInput`, `Decision`, `AuditTrace`, `TrainingExample`, `DatasetManifest` | `types.ts` | Wire shapes shared by trainer, data pipeline, ontology, runtime. |

## CLI

Three subcommands, runnable directly via Bun:

```
bun packages/eight-bdh/cli.ts info
bun packages/eight-bdh/cli.ts detect
bun packages/eight-bdh/cli.ts decide --request "rewrite this auth middleware"
```

`info` prints the current package metadata and the Phase 0 5M config. Example output (matches `cli.ts` `cmdInfo()` exactly):

```json
{
  "package": "@8gent/eight-bdh",
  "version": "0.1.0",
  "model_id": "8gent-0.1.0-bdh-r:10m",
  "phase": "0",
  "status": "scaffold-only-no-weights",
  "config_phase_0_5m": {
    "n_layer": 6,
    "n_embd": 160,
    "n_head": 4,
    "mlp_internal_dim_multiplier": 64,
    "dropout": 0.1,
    "vocab_size": 256
  }
}
```

`detect` delegates to `scripts/detect-compute.ts` and recommends a per-phase compute target (local M2 Max vs RunPod). `decide` accepts `--request <text>`, optional `--state-json <json>`, and optional `--authority <0..5>`; in Phase 0 it returns a deterministic `clarify` stub.

## Phase 0 status table

| Gate | Status |
|---|---|
| Spec scaffold (types, public API, CLI surface) | Pass |
| Trainer config JSON pinned to `BdhConfig` constants | Pass |
| `pathwaycom/bdh` subtree pulled into `trainer/upstream/` | Pending (Phase 0 step 1, run manually) |
| MPS smoke test on M2 Max (`TRAINING-NOTES §7.3`) | Pending |
| 5M model trained on 1k synthetic examples | Pending |
| Phase 0 inference latency under 100ms (`ORCHESTRATOR §5`) | Pending |
| `decide()` wired to a real `LocalClient` | Pending |
| Routing accuracy benchmark (Phase 1 exit gate) | Out of scope for Phase 0 |

## What is NOT in this package

Per `ORCHESTRATOR §11` and §6:

- No edits to `packages/orchestration/task-dispatcher.ts`. The BDH path is feature-flagged behind `EIGHT_BDH_ROUTER` and lands in Phase 1.
- No changes to `packages/providers/`. The model is internal to the harness, not a provider.
- No weights. Checkpoints land in `packages/eight-bdh/models/` (gitignored) after the Phase 0 training run.
- No tokenizer. Vocab is 256 bytes; the corpus is byte-serialised JSONL at training time (`TRAINING-NOTES §8`).
- No latency measurements. Phase 0 produces them.
- No vessel-side inference. `eight-vessel.fly.dev` integration is a Phase 1+ deliverable.
- No bespoke training infra. We use BDH upstream via subtree.

## Links

- Spec: `../../docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md`
- Training notes: `../../docs/specs/8GENT-0.1-BDH-TRAINING-NOTES.md`
- Concept ontology rationale: `./ONTOLOGY-RATIONALE.md`
- Brand rules: `../../BRAND.md`
- Trainer scaffold: `./trainer/README.md`
