# PRD: Prepare the Throne

**For:** 8gent-code engineering (8TO Rishi lead, harness-adjacent contributors)
**Authority:** Chair (James Spalding), informed by L5 boardroom decision 2026-04-28
**Status:** Drafted while Phase 0 training is in flight; integration starts after PR #2016 lands and the Phase 0 checkpoint exists

## Problem in one sentence

The Phase 0 BDH checkpoint will exist on James's M2 Max within ~60 minutes. We need a minimum-viable integration path so the harness can call the model, get a routing decision, and emit an AuditTrace, **without** committing to a default-on roll-out. The dragon does not need to think yet. It needs a chair.

## What we are expecting from the dragon (honest)

A 5M-parameter BDH trained on a 1k rule-based synthetic corpus (no closed-weight teacher, no human-labelled gold set). After ~2500 iterations on MPS:

- It can emit **structurally-valid `Decision` JSON** when prompted with a partial state.
- It produces **non-empty fired-synapse positions** that map (post-probe) to ontology concept ids.
- It runs at **<100ms inference latency** per decision on M2 Max.

What we are NOT expecting:

- Routing accuracy beyond what a coin-flip across five decision kinds would give. The training labels were random by construction (rule-based), so the model learned the byte-level grammar, not the routing logic. **Phase 1 with real teachers + the gold set is when routing quality becomes measurable.**
- Per-concept synapse precision >50%. The probe runner against real-world examples is a Phase 1 deliverable.
- Production reliability. The first checkpoint is a heartbeat artifact, not a service.

The throne is for a hatchling that can press a button or two. Build it that way.

## Constraints (No-BS box)

| Field | Value |
|---|---|
| Problem (1 sentence) | Wire the Phase 0 checkpoint into the harness as an opt-in router, with a clean fallback to the existing dispatcher and zero default behaviour change. |
| Constraint | Quality (no regression on the default path) and blast radius (single feature flag, single new dependency). |
| NOT doing | (a) Replacing `task-dispatcher.ts`. (b) Changing the daemon protocol. (c) Wiring the vessel-side `eight-vessel.fly.dev` inference path (Phase 1+). (d) Writing the eval harness (separate PRD). |
| Success metric | `EIGHT_BDH_ROUTER=on bun run tui` emits AuditTrace records to `~/.8gent/g8way/audit-traces.jsonl` for at least 5 decisions during a manual smoke session. `EIGHT_BDH_ROUTER=off` (default) leaves the harness behaviour unchanged. |
| Estimated scope | ~250-400 LOC across 3-4 files. No new packages. No subtree pulls. No checkpoint format changes. |

## Workstream W0: LocalClient implementation

Today `packages/eight-bdh/client.ts` exports a `LocalClient` shell that throws "not implemented yet". The throne work replaces that body.

### Requirements

- Spawn a Python sidecar (or HTTP-served Python process) that loads `packages/eight-bdh/checkpoints/phase-0-5m.pt` and serves inference over a thin protocol.
- Bun talks to the sidecar via stdio JSON or HTTP localhost. Pick one based on cold-start latency; stdio is simpler.
- Input: `OrchestratorInput` (already typed in `types.ts`).
- Output: `{ decision: Decision, trace: AuditTrace }`. Decision parsed from the model's byte-stream output via `decode.ts`. AuditTrace built from the activation vector via `extractTrace()`.
- Honour `BDH_CHECKPOINT_PATH` env var so users can swap weights.
- Surface a clean `dispose()` that kills the sidecar on harness shutdown.

### Files

- `packages/eight-bdh/client.ts` (edit) - replace LocalClient body
- `packages/eight-bdh/scripts/serve.py` (new) - the Python sidecar; ~80-120 LOC
- `packages/eight-bdh/index.ts` (edit) - have `decide()` route through LocalClient when a checkpoint is configured

### Definition of done

- `bun packages/eight-bdh/cli.ts decide --request "..." --use-weights` returns a real Decision (not the stub) when the Phase 0 checkpoint exists.
- The first call cold-starts the sidecar; subsequent calls reuse it.
- Sidecar process dies cleanly when the parent exits.

## Workstream W1: Feature-flagged dispatcher integration

`packages/orchestration/task-dispatcher.ts` is the existing routing surface. We add an optional pre-step that consults BDH if the flag is on.

### Requirements

- New env flag: `EIGHT_BDH_ROUTER` (values: `on`, `off`, `shadow`). Default `off`.
- `off`: existing behaviour, no change.
- `shadow`: existing dispatcher decides. BDH ALSO decides in parallel and the trace is logged to G8WAY but the BDH decision is discarded. **Shadow mode is the safe default for any external testing.**
- `on`: BDH decides. If BDH errors or returns an invalid Decision, fall back to the existing dispatcher and log the failure. Never let BDH crash a session.
- Every BDH decision (in `on` or `shadow` mode) calls `auditedDecisionEnvelope()` from `packages/eight-bdh/audit.ts`.

### Files

- `packages/orchestration/task-dispatcher.ts` (edit, ~30 LOC added)
- `packages/orchestration/role-config.ts` (edit, optional `bdh_module_ids?: string[]` field added to role schema for forward compat with Phase 4 modules)

### Definition of done

- Existing tests pass with `EIGHT_BDH_ROUTER=off`.
- New test: dispatcher in `shadow` mode logs an audit trace per decision while preserving heuristic behaviour.
- New test: dispatcher in `on` mode falls back to heuristic when BDH throws.

## Workstream W2: G8WAY audit envelope wiring

`packages/eight-bdh/audit.ts` already implements `validateForAuthority`, `persistAuditTrace`, and `auditedDecisionEnvelope`. They are correct. They need a caller.

### Requirements

- `packages/g8way/audit.ts` (new file or extension to existing) reads JSONL from `~/.8gent/g8way/audit-traces.jsonl` and exposes the records to the dashboard surface in `apps/dashboard/`.
- The dispatcher integration in W1 is the only writer for now.
- Schema match exactly the `PersistedRecord` shape in `packages/eight-bdh/audit.ts`.

### Definition of done

- Dashboard can render a list of recent audit traces.
- L5 decisions never reach the persist path (the L5 reserved-for-boardroom rule already enforced in `validateForAuthority`).
- `BDH_AUDIT_PATH` env var works for testing without polluting the user's real log.

## Workstream W3: Acceptance smoke test

A single end-to-end script that proves the throne works.

### Files

- `packages/eight-bdh/scripts/throne-smoke.ts` (new) - orchestrates: (1) confirm checkpoint exists, (2) spawn LocalClient, (3) issue 10 hand-built `OrchestratorInput`, (4) verify each returns a Decision + AuditTrace, (5) verify `~/.8gent/g8way/audit-traces.jsonl` has 10 new lines, (6) print summary.

### Definition of done

- `bun packages/eight-bdh/scripts/throne-smoke.ts` exits 0 with the Phase 0 checkpoint present.
- Exit non-zero with a clear error message if any of the 6 steps fail.

## What this PRD does NOT cover

- The eval harness (separate PRD attached to PR #2016, "PHASE-1 eval harness prereq").
- The 200-example dual-labelled gold set (W2 of the eval PRD).
- The AutoResearch HyperAgent loop (W3 of the eval PRD).
- The TUI trace card (8DO dissent item, separate ticket).
- Vessel-side inference at `eight-vessel.fly.dev` (Phase 1+).

## Sequencing

W0 -> W3 must complete before W1 ships behind a flag. W2 can land in parallel with W1. None of these workstreams should ship to main before:
- PR #2016 (Phase 0 scaffold + training pipeline + heuristic baseline) merges
- The Phase 0 verification report shows all 5 heartbeat gates pass
- The eval-harness PRD W2 (gold set creation) is at least scoped, even if not yet built

## Estimated effort

| Workstream | Time | Owner |
|---|---|---|
| W0 LocalClient + serve.py | 1-2 days | 8TO Rishi |
| W1 Dispatcher integration | 0.5-1 day | 8TO Rishi (impl), 8SO Karen (review for fallback safety) |
| W2 G8WAY audit reader | 0.5 day | 8GO Solomon |
| W3 Throne smoke script | 0.5 day | 8TO Rishi |

Total: 3-4 days of focused work.

## What ships when this PRD is done

A trained 5M BDH checkpoint that the harness can call, get a Decision from, and log an AuditTrace for, all behind `EIGHT_BDH_ROUTER=on`. The harness behaviour with the flag off is unchanged. The dragon has a throne. We do not crown it as orchestrator until Phase 1 ships and the gold-set rubric clears.

## End

Sign-off: the chair greenlights this PRD as the integration path for the Phase 0 checkpoint. Implementation begins after PR #2016 merges. Boardroom may reopen W1's `on`-mode default at any time without amending this doc.
