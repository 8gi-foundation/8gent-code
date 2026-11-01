# Generator / Evaluator: The Hardest Part of a Loop

The hardest part of a loop is not getting the agent to run — it's putting something inside that can say "no." And the agent writing the code is the one *least* likely to say it.

## Why an agent praises its own work

Ask an agent to grade what it just produced and it praises it confidently, even when a human plainly sees the quality is mediocre. This is not a smarts problem — it's grading one's own homework. The context the code was written in is already stuffed with the reasons it was written that way, so when the agent looks at its output it doesn't see the *result* — it sees the chain of self-persuasion that led there.

Inside a loop this is amplified: if every "is this good enough" is decided by the agent that just wrote it, each round it nods at itself, and the longer it runs the further it drifts from real quality.

## Tune a skeptic; don't fix a modest author

Making the generator more self-critical works poorly. Tuning a *standalone* evaluator to be skeptical is far more tractable than making a generator critical of its own work. The difference is structural, not wording: you can't ask an author to step outside its own perspective, but you can swap in another agent with entirely different instructions that looks at the code from scratch, carrying none of the self-persuasion.

The idea is borrowed from GANs — one network builds, one picks faults — ported to a generator that writes and an evaluator that reviews.

## The evaluator must act, not just read

Swapping agents isn't enough. If the evaluator only reads code, it judges "does this look right," not "does it run right." Hook it to tooling (e.g. Playwright MCP for frontend) so it can open the page, click buttons, screenshot, and inspect the DOM like a QA engineer. That shifts the basis from "this JSX looks fine" to "I clicked the button, the page navigated, here's the screenshot."

Two more calibrations:
- **Swap the underlying model too.** The same model with new instructions often keeps its blind spots.
- **Default to doubt.** Tell the evaluator to assume the code is broken until proven otherwise.

## Hand the final say to a fresh model

In Claude Code, `/goal` gives an agent a condition and runs until it's met. Crucially, after each turn a *small fast model* checks whether the condition holds — completion is decided by a fresh model, not the one doing the work. This is the maker-checker principle, decades old in banking: the person entering a large transfer and the person reviewing it must differ.

(Don't confuse `/goal` with `/loop`, which merely reruns on an interval. Codex reaches the same capability through automations plus agent configuration.)

## A representative evaluator setup

```
# Evaluator agent (.claude/agents/reviewer.md)
ROLE: Adversarial code reviewer.
ASSUME: this code is BROKEN until proven otherwise.
DO NOT praise. Find what fails.
CHECK, in order:
  1. Does it run? (execute, don't read)
  2. Tests: run them, paste real output.
  3. Edge cases the author skipped.
  4. Does behavior match the ticket?
USE Playwright MCP: open the page, click, screenshot, inspect the DOM.
  Judge behavior, not intent.
VERDICT: PASS only if every check holds. Otherwise REJECT + list each reason.

# Stop condition, judged by a fresh small model
/goal all tests in test/auth pass and the lint step is clean
```

## The principle

A loop's floor is its evaluator. The generator's level decides what a loop *can* produce; the evaluator's level decides what it *will not* produce. The four steps that grow a loop's ability to say "no":

1. Separate generation from judgment **structurally** (different agent).
2. Tune the evaluator into a **skeptic** (default to doubt).
3. Make it verify by **acting**, not reading.
4. Hand the final say to a **fresh model**.

A strong generator with a weak judge produces confident garbage; a modest generator with a sharp judge produces slow, reliable progress — and the second is what compounds. The evaluator is where the engineering effort belongs.
