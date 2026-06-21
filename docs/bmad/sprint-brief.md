# Sprint Brief: P0 Gate Closure

**Date:** 2025-07-21
**Prepared by:** 8TO (Rishi)
**Status:** Draft

---

## Objective

Close the four P0 gates blocking the 8gent-code 0.19 release. Each gate must pass test-driven verification before the next gate opens.

---

## Critical Path

```
Loop-Stop Conditions → Vessel Verification → Maker-Checker Pattern → Vessel Autonomy Ladder
```

---

## Gate 1: Loop-Stop Conditions

**Owner:** Rishi
**Definition of Done:** Every agent action class has documented stop conditions with passing tests.

### Deliverables
- [ ] Edge case map: all agent action categories
- [ ] Stop condition catalog: for each action type, what triggers a hard stop vs. retry
- [ ] Test suite: bun:test covering all stop condition paths
- [ ] Runbook: how to extend stop conditions for new action types

### Risk flags
- CUA retry logic has no visible test coverage
- Infinite loop detection is not instrumented

---

## Gate 2: Vessel Verification Layer

**Owner:** Rishi
**Definition of Done:** A verified vessel output is defined, measurable, and has an automated assertion.

### Deliverables
- [ ] Definition: what constitutes a "verified" vessel delivery
- [ ] Verification harness: automated check that output meets the definition
- [ ] Assertion library: reusable assertions for agent outputs
- [ ] Integration test: end-to-end proof the layer works

### Open question
What does "verified" mean? Candidate criteria:
- Output matches requested task
- No errors in execution trace
- Side effects are documented and reversible
- Token usage within expected bounds

---

## Gate 3: Maker-Checker Pattern

**Owner:** Rishi
**Definition of Done:** Destructive actions require a human confirmation step before execution.

### Deliverables
- [ ] Destructive action taxonomy: which actions are gated
- [ ] Maker-checker middleware: intercept, confirm, execute
- [ ] Test suite: all destructive paths have maker-checker coverage
- [ ] Override mechanism: for automation contexts with explicit consent

### Scope
Gated actions: git reset, branch deletion, file overwrite, credential access, network to external hosts.

---

## Gate 4: Vessel Autonomy Ladder

**Owner:** Rishi
**Definition of Done:** Risk tiers are defined, implemented, and enforced per agent invocation.

### Deliverables
- [ ] Risk taxonomy: tier 0 (read-only) through tier 3 (destructive)
- [ ] Enforcement layer: each tier is enforced by permissions package
- [ ] Test suite: cross-tier isolation verified
- [ ] Documentation: how to assign tiers to new capabilities

### Tiers
- **Tier 0:** Read-only. No state changes.
- **Tier 1:** Local state. File writes, git commits.
- **Tier 2:** Remote state. Network calls, external APIs.
- **Tier 3:** Destructive. Deletes, resets, credential access.

---

## Capacity Requirement

**Estimated:** 3-4 hour focused sprint per gate.
**Total:** 12-16 hours across all four gates.
**Recommended:** Single 4-hour block per gate, not scattered across days.

---

## Dependencies

- Gate 2 depends on Gate 1 (verification cannot exist without verified stop conditions)
- Gate 3 depends on Gate 2 (maker-checker needs verified output)
- Gate 4 depends on Gate 3 (autonomy ladder builds on maker-checker)

---

## Next Steps

1. James approves sprint brief
2. Calendar block allocated for deep work (suggested: James's 9pm-1am window)
3. Gate 1 work begins
4. Rishi reports completion with test output

---

## Acceptance Criteria

- All four gates have passing test suites
- Zero untested code paths in the critical path
- bun:test run shows 100% pass rate on gated packages
- Release notes drafted for 0.19
