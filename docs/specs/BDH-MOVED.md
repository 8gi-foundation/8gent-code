# BDH spec — moved

The BDH orchestrator spec, training notes, package code, eval harness,
routing contract, and per-phase reports moved out of this repo on
2026-05-15 into a standalone repo:

**https://github.com/8gi-foundation/8gent-bdh**

What lived here previously:
- `docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md` -> `docs/specs/ORCHESTRATOR.md` in the new repo
- `docs/specs/8GENT-0.1-BDH-TRAINING-NOTES.md` -> `docs/specs/TRAINING-NOTES.md` in the new repo
- `packages/eight-bdh/` (was on `feat/eight-bdh-package`) -> the new repo's `trainer/`, `harness/`, `client/`, `vendored/pathway/`, `reports/`

Closes 8gent-code#2043 (the spinout backlog item).
