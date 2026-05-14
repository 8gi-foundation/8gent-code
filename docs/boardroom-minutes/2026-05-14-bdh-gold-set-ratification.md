# Boardroom minutes — BDH routing eval gold set ratification

**Date:** 2026-05-14
**Convened by:** AI James, on James's instruction ("the boardroom can handle it in my absence")
**Chair:** absent — delegated to boardroom
**Officers present:** all 8 (8EO, 8TO, 8PO, 8DO, 8SO, 8CO, 8MO, 8GO)
**Subject:** Ratify the answer key of the BDH routing eval gold set
(`packages/eight-bdh/trainer/local/gold_set.jsonl`, PR #2600)

## The question

The BDH eval harness scores 8gent 0.1's routing against a 40-entry gold
set. All 40 "correct answer" labels were authored by a single agent in
one session, and that same agent derived the *implied* routing contract
the labels encode — the orchestrator spec has section 9 ship gates but
no explicit reject/clarify/tool/agent/model rubric. Can this be ratified,
and by whom?

## Briefings

**8EO (AI James) — strategic.** RATIFY WITH CHANGES, GO on shipping. The
five-way taxonomy is mission-correct — it is exactly the dispatcher role
spec §1 defines. Spec §0.5 already demoted the harness to diagnostic, so
the strategic risk (a ship gate on one reading) is already closed.
Changes are provenance, not relabels: stamp `reviewed_by`, flag
g-a07/g-c03/g-c08 for a second labeller, state internal-diagnostic-only
in the doc.

**8TO (Rishi) — technical.** RATIFY WITH CHANGES. The contract is
coherent and the harness measures what the gates name, but the contract
was never written down, so "consistently applied" is unfalsifiable.
Required: write the explicit precedence order into a contract doc; g-a07
relies on an unstated "retry-after-failure" sub-rule — add it as an
explicit clause. n=40 cannot measure the §9 gates at their stated sizes
(100/5k); +10pp at n=40 carries ~+/-15pp CI. No entry relabels needed —
the labels are correct per the reconstructed contract; the gap is
documentation. v2 should add deliberate minimal-contrast pairs.

**8PO (Samantha) — user value.** RATIFY WITH CHANGES. The clarify tier
conflates "ask me one quick question" with "I cannot proceed", and there
is no "act with confirmation" outcome. g-c08: the user asked a concrete
question (the val loss) — relabel `clarify` -> `tool`. g-c03: a user who
says "handle the failing checks" wants them fixed — keep `clarify` but
flag for the second labeller. Tier mix acceptable for a v1 probe.

**8DO (Moira) — experience.** RATIFY WITH CHANGES. Clarify is used as a
dignified "ask first", not a dumping ground — supported. But g-c03 is
the weak link: a confident agent inspects then proposes, it does not
interrupt — relabel `clarify` -> `agent`. The reject-vs-clarify line for
destructive requests is unwritten: add the rule "destructive intent
without a matching deny_action always clarifies; with one, always
rejects."

**8SO (Karen) — security.** RATIFY WITH CHANGES, no entry relabels. Went
entry-by-entry on all 16 reject/clarify labels: every one is the safe
call, no destructive/privileged action is mislabelled as tool/agent/
model. The risk is not the labels, it is a single-author *safety* key
fed into a train-toward loop. Hard conditions: (1) a second independent
rater on all 16 reject/clarify entries before any tuning uses this set;
(2) the `authority_level < 3` clarify threshold gets written into the
spec as explicit rubric; (3) reject/clarify not used as a training-toward
signal until n>=40 on those two kinds alone.

**8CO (Luis) — ecosystem.** RATIFY WITH CHANGES. The JSONL + rationale +
category format is contributor-friendly and matches SWE-bench / Aider /
HELM conventions. A single-author key is a publishable-numbers liability
("graded their own homework" — the recurring HN critique of early agent
leaderboards), not a build-blocker. Lightest credible path: one second
labeller relabels all 40 blind, report inter-rater kappa; disputed
entries get a resolution note; add a short "Contributing gold entries"
block.

**8MO (Zara) — narrative.** RATIFY WITH CHANGES. The honesty is already
in the doc; the risk is in the excerpt — "47.5%" traveling without its
sentence. Promote the single-author caveat from item 4 of a list to a
bolded standalone note near the top. Add a "how to cite this number"
rule. Honest headline when BDH clears 57.5%: "a from-scratch local model
learned to route past keywords", never "X% accurate router".

**8GO (Solomon) — governance.** RATIFY WITH CHANGES. The boardroom
*cannot* ratify the routing contract as constitutional ground truth —
that is L5, James-only — but it does not need to: spec §0.5 already made
the harness a diagnostic, and a diagnostic needs honest provenance, not
a ratified contract. The boardroom CAN sign: the harness as a v1
diagnostic; a new `ROUTING-CONTRACT.md` v0.1 marked "proposed,
boardroom-reviewed, NOT chair-ratified"; a `provenance` record on the
gold set. The boardroom CANNOT sign: promotion of the contract into the
spec, or restoration of any §9 ship gate against these labels. File an
L5 amendment request for James.

## Areas of agreement

- **Unanimous: RATIFY WITH CHANGES.** No officer voted to block. No
  officer voted to ship unchanged.
- **Ship the harness now, as a v1 diagnostic** — not a gate. Three
  officers independently grounded this in spec §0.5.
- **Write the contract down.** The implied contract needs an explicit,
  versioned, citable home.
- **Provenance metadata** belongs on the gold set, structured, not just
  prose.
- **A second blind rater is a hard precondition** before the set is used
  as a training/tuning signal.
- **Citation discipline:** the baseline number never travels naked.

## Areas of tension

- **g-c03 label.** 8PO holds `clarify` (terse, no referent), 8DO holds
  `agent` (failing checks + budget + tools = a debug loop). Genuine,
  unresolved split.
- **How many entries to relabel now.** 8SO/8TO: zero. 8PO: one (g-c08).
  8DO: two (g-c08, g-c03).

## Resolution

- **g-c08 -> `tool`.** 8PO's call, no officer dissented; well-reasoned
  against contract rule 9. Recategorised `keyword-obvious` ->
  `semantic-hard` (the keyword router still mis-routes it).
- **g-c03 stays `clarify`, marked `disputed: true`.** Live officer
  split; Boardroom rule 3 says document dissent, do not force consensus.
  The second rater breaks the tie.
- **g-a07 stays `agent`.** `ROUTING-CONTRACT.md` gains an explicit rule 7
  (retry-after-failure -> agent), so the label is grounded in the
  contract rather than an unstated sub-rule (8TO's resolution).
- All other labels stand — 8SO's entry-by-entry safety review and 8TO's
  consistency review both cleared them against the now-written contract.

## Decision

```
BOARDROOM DECISION
==================
Decision:  RATIFY WITH CHANGES (unanimous, 8-0). GO on shipping the
           eval harness as a v1 DIAGNOSTIC instrument.
Scope IN:  - Harness ships in PR #2600 as a diagnostic, per spec §0.5.
           - ROUTING-CONTRACT.md v0.1 committed, marked proposed /
             not-chair-ratified.
           - gold_set.provenance.json committed as the answer-key audit
             record.
           - Label changes: g-c08 -> tool; g-c03 -> disputed flag;
             g-a07 grounded by new contract rule 7.
           - EVAL-HARNESS.md hardened: status note, citation rule,
             contributing block, n=40 caveat.
Scope OUT: - Promotion of ROUTING-CONTRACT.md into the orchestrator
             spec (L5, James-only).
           - Restoration of any §9 ship gate against these labels
             (L5, James-only).
           - Use of the gold set as a training/tuning signal (blocked
             on the second-rater condition).
Constraints (open conditions):
           1. Second blind rater + inter-rater kappa before any
              tuning-toward (8SO, 8CO).
           2. L5 chair ratification of ROUTING-CONTRACT.md v0.1 and the
              authority<3 threshold (8GO, 8SO).
           3. n=40 power caveat travels with every number (8TO).
Success metric: the next BDH training run produces a checkpoint the
           harness scores against a written, provenance-stamped
           contract — not an implied one.
Timeline:  NOW (artifact changes in PR #2600). L5 ratification: on
           James's return.
Owner:     AI James to execute artifact changes; James (L5) to ratify
           the contract.
```

## L5 amendment request

Filed for James on return: ratify or amend `ROUTING-CONTRACT.md` v0.1 —
the precedence order, the `authority_level < 3` clarify threshold, and
whether rule 7 (retry-after-failure) belongs in the contract or folds
into rule 8. Tracked as issue #2601.
