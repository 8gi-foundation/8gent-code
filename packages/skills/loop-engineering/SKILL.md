---
name: loop-engineering
description: Design, build, and audit self-running agentic loops — systems that prompt coding agents on a schedule instead of a human prompting them by hand. Use this skill whenever the user wants to set up an autonomous or overnight agent workflow, a morning-triage or CI-watching automation, a "runs while I sleep" pipeline, a generator/evaluator (maker-checker) review setup, or a scheduled Claude Code/Codex job. Also trigger when the user asks why their loop drifts, praises its own output, redoes work, collides on git, or burns tokens — these map to specific loop failures this skill diagnoses. Use it even if the user just says "automate this agent" or "make this run on its own" without naming loops explicitly.
---

# Loop Engineering

A loop is a system that **discovers** work, **hands** it to an agent, **verifies** the result, **persists** state, and **reschedules** — all without a human in the inner cycle. The human moves from operating the agent to designing the system that operates it.

This skill helps you (a) build a loop that is safe from day one, and (b) diagnose a loop that has gone wrong. The hard part is never building the loop — it is installing something inside it that can say **"no."**

## The mental model

Loop engineering is the fourth layer of a stack. Each layer up, the unit of concern grows, and a mistake survives more turns before anyone catches it.

| Layer | Minds | Failure blast radius |
|---|---|---|
| Prompt | The words for the model | One wrong answer, caught instantly |
| Context | What's in the window now | A confidently wrong answer, caught on read |
| Harness | One run: tools, actions, "done" | One bad diff, caught at review |
| **Loop** | Scheduling the harness to run itself | Wrong assumption written to state, read back as fact, built on for days |

**The single most important intuition:** the cost of a mistake scales with the number of turns it survives before discovery, and a loop is by construction a machine for maximizing turns. Every safety mechanism below exists to shorten the distance between a mistake and its discovery.

## The five moves of one turn

Drop any one and the loop won't turn, or turns in place. Each maps to one of the six parts you build it from.

| Move | What it does | Built on |
|---|---|---|
| **Discovery** | Finds this turn's work on its own (reads CI / issues / commits) | Skills |
| **Handoff** | Hands the task off in isolation | Worktrees |
| **Verification** | Swaps in another agent to say "no" | Sub-agents |
| **Persistence** | Writes state outside the conversation | Memory (disk) |
| **Scheduling** | Makes it turn round after round | Automations |

Discovery sets the ceiling: surface worthless work and the other four are done beautifully in service of nothing. Verification is the easiest to skip and the least affordable to.

## How to use this skill

**If the user is building a loop** → follow `references/build-recipe.md`. It walks the five-step path from a one-line `/loop` to a complete six-element loop, with a minimal annotated template. Always insist on the evaluator and the human-review door before scaling parallelism.

**If the user's loop is misbehaving** → go to `references/failure-modes.md`. Each symptom maps to exactly one skipped move; the fix is to install that move.

**If the user is designing the evaluator** (the hardest and highest-leverage part) → read `references/generator-evaluator.md`. The core finding: an agent grading its own work praises it, so you tune a separate skeptic rather than trying to make the author self-critical.

**If the user needs to choose where it runs** (laptop vs cloud) or map commands across Claude Code/Codex → see `references/scheduling-and-toolchains.md`.

## Non-negotiables (carry these into every loop)

These four come from the costs that accrue silently while a loop runs — verification debt, comprehension rot, cognitive surrender, and token blowout. They reinforce one another and come due all at once, so guard against them structurally, not by good intentions.

1. **Separate the generator from the evaluator.** Never let the agent that wrote the code decide whether it's good. Tune an independent evaluator that defaults to doubt and *acts* (runs tests, clicks the page) rather than just reading. Hand the final stop-condition check to a *fresh* model. This is the maker-checker principle from banking.

2. **Persist to disk, not the chat window.** The agent forgets when context flushes; the repo does not. A loop's memory lives in a markdown file or a board, committed back.

3. **Cap before you ship.** Set per-run, daily, and max-retry ceilings *before* the first unattended run, not after the first surprising bill. A loop without caps has delegated its spending authority to its own bugs.

4. **Keep one door open.** Build at least one checkpoint where the loop pauses for a human — never auto-merge during the first runs. The pause's value isn't that the human always intervenes; it's that it keeps the human *able* to. Read a representative sample of output every day and force yourself to explain a few changes. Inability to explain = your mental map has fallen behind.

## The posture that decides everything

The same loop, built by two people, yields opposite outcomes — separated by one or two checkpoints. A loop amplifies whatever the builder brings: understanding amplifies into more understanding, laziness into more laziness. It is a faithful multiplier.

Loops make generation nearly free (code, plans, PRs, fixes) and leave **judgment** as the scarce resource — knowing which output is actually right versus merely plausible. The gap between "looks reasonable" and "is right" is exactly where the engineer still exists.

So the rule to carry: **stop prompting the agent, design the system that prompts it — but design it like someone who intends to stay the engineer, not just the one who presses go.**
