# 8gent 0.1 Concept Ontology - Rationale

Owner: 8GO (Solomon). Spec: `docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md` §4.4 and §7.

## Purpose

The ontology is a fixed, ordered list of concept identifiers that the BDH
concept head is trained to predict. It is the foundation of monosemanticity
in 8gent 0.1: each position in `CONCEPT_VOCAB` corresponds to one synapse in
the concept head, and the multi-label binary cross-entropy loss during
training pins that synapse to one human-readable concept. The contract is:
`activations[i]` always refers to `CONCEPT_VOCAB[i]`. If the order changes,
every saved checkpoint, every G8WAY audit record, and every downstream
visualisation breaks. That is why this file is small, explicit, and
versioned. We engineer monosemanticity rather than hoping it emerges.

## Category breakdown

| Category        | Count | Spec target | Deviation |
|-----------------|-------|-------------|-----------|
| task-class      | 25    | ~25         | 0         |
| sensitivity     | 15    | ~15         | 0         |
| vessel-fit      | 9     | ~9          | 0         |
| budget-signal   | 6     | ~6          | 0         |
| policy-signal   | 12    | ~12         | 0         |
| provider-fit    | 25    | ~25         | 0         |
| state-history   | 15    | ~15         | 0         |
| output-kind     | 5     | ~5          | 0         |
| reserve         | 8     | ~8          | 0         |
| **Total**       | **120** | **~120**  | **0**     |

All nine categories hit their spec target exactly. No padding. No shortfall.
Every concept name is pulled from a real harness signal that already exists
(`packages/orchestration/`, `packages/g8way/`, `packages/providers/`,
`packages/permissions/`) or is referenced by name in the spec.

## Naming convention

All identifiers are `kebab-case` ASCII. Family prefixes are reserved and
must be honoured by anyone proposing new concepts:

- `vessel-*` is reserved for vessel-fit signals. The suffix is the officer
  code in original casing (`8EO`, `8TO`, `8PO`, `8DO`, `8SO`, `8CO`, `8MO`,
  `8GO`) followed by `-fits`. The catch-all is `vessel-none-fits`.
- `decision-*` is reserved for output-kind signals. Each value mirrors a
  member of `DecisionKind` in `types.ts`. One `decision-*` should fire per
  decision; the highest-weight one selects the head.
- `budget-*` is reserved for budget envelope signals.
- `authority-*` is reserved for G8WAY authority levels (`l0..l5`). These
  are signals, not policies; the policy lives in `audit.ts`.
- `reserve-*` is reserved for unallocated synapses (see below).

Outside those prefixes, names are nouns or short noun phrases describing
the signal in lowercase kebab-case. Avoid verbs unless the signal
genuinely describes an action (e.g. `loop-suspected`).

Renaming is forbidden under a single ontology version. If a signal needs a
clearer name, it ships in the next version as a new entry; the old entry
stays in place until the version bump retires it.

## Reserve slots

The eight `reserve-NN` slots are intentional. They exist for two reasons.

First, BDH's monosemanticity is not a hard guarantee. Post-training probes
(planned for Phase 1 evaluation) will surface synapses that reliably fire
on a concept we did not name in advance. When that happens, 8GO inspects
the activation pattern, names the concept, and relabels one of the reserve
slots in the next ontology version. Without reserves, the only way to add
a concept post-hoc is to retrain from scratch; with reserves, we extend
the vocabulary by relabelling a slot the model has already learned to use.

Second, the slots act as canaries. If a reserve slot fires consistently in
the wild before being named, that is a signal that the existing vocabulary
is missing a real concept and an ontology refresh is overdue.

Who can fill a reserve slot: 8GO only. When: at an ontology version bump,
documented in the changelog with the activation evidence that motivated
the relabelling. The slots are not sandbox space for arbitrary additions.

## Drift policy

`ONTOLOGY_VERSION` follows model SemVer per `project_model_versioning.md`:
`MAJOR.MINOR.PATCH`.

- **PATCH bump** (`0.1.0` -> `0.1.1`): description text edits, comment
  edits, no change to the ordered list of identifiers. Hash unchanged.
  Safe to roll out without retraining.
- **MINOR bump** (`0.1.0` -> `0.2.0`): one or more reserve slots relabelled
  to a real concept. Identifiers at non-reserve positions unchanged. Old
  checkpoints still load but emit a warning; downstream consumers should
  retrain the concept head when convenient.
- **MAJOR bump** (`0.1.0` -> `1.0.0`): any reorder, removal, or rename of
  a non-reserve concept. Hard break. All checkpoints invalidated. All
  audit records prior to the bump are still valid evidence under the
  prior version but cannot be re-projected onto the new vocabulary.

`ONTOLOGY_HASH()` is the SHA-256 over `JSON.stringify(CONCEPT_VOCAB)`. Any
identifier change or reorder produces a new hash. Audit records persist
their version and hash; the runtime verifies the loaded model's hash
matches the ontology's hash before serving a decision. Mismatch is a hard
fail by design - we would rather refuse a decision than serve one whose
synapse map cannot be trusted.

What breaks downstream on a MAJOR bump:

- All saved BDH checkpoints (concept head width or position changed).
- The training data manifest (`concept_coverage` keys reference old IDs).
- G8WAY audit log queries that filter on concept IDs.
- The `decode.extractTrace()` call sites that pin a specific concept ID.
- Visualisation tooling in `apps/dashboard` (planned).

A MAJOR bump therefore requires a coordinated change: retrain, re-index
audit logs (or freeze the old log under the prior version), and update
any hard-coded concept references. Solomon (8GO) sequences the rollout.

## Open questions for the boardroom

Cited from spec §10:

1. **Question 2 - "Who owns the concept ontology?"** Solomon (8GO) is the
   natural owner of an audit-shaped vocabulary because the ontology is
   primarily a constitutional artifact: it defines what counts as evidence
   under G8WAY. This file proceeds on the assumption that ownership rests
   with 8GO; a boardroom resolution to confirm or reassign is requested.
   Default action per the spec's silent-assent clause: 8GO inherits
   ownership in seven days.

2. **Provenance graph storage** (spec §10 question 3, 8TO's call) does not
   change the ontology itself, but the choice between SQLite and Parquet
   affects how cheaply we can join audit traces to training examples by
   concept ID. The ontology assumes per-row concept ID storage is cheap;
   if Parquet is selected, this assumption holds; if a key-value store is
   selected, we may want to store concept IDs as the integer index rather
   than the string. Flagging for the boardroom.

3. **Vessel coverage**. The `vessel-*` family uses the eight officers in
   the current Constitution. If the officer set changes (additions or
   removals), the vessel-fit category needs a corresponding ontology
   bump. This is a minor risk in Phase 1 but should be reviewed at every
   constitutional amendment.

4. **Reserve slot count**. Eight reserves at 120 total is just under 7%.
   If Phase 1 probes find more than three emergent concepts, we will run
   out of reserves before the Phase 2 ship gate. The boardroom should
   pre-authorise an emergency MINOR bump path that does not require full
   re-deliberation if reserve exhaustion happens mid-phase.

End of rationale.
