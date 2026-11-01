---
name: systematic-debugging
description: A reproducible debugging loop. Apply when encountering any bug, test failure, or unexpected behavior, before proposing a fix.
trigger: /debug
aliases: [/systematic-debug, /sdbg]
tools: [bash, read, grep]
---

# Systematic Debugging

A debugging session is a scientific one. State the hypothesis, run the experiment, read the evidence. Guessing wastes tokens and trust.

## When to use

- A test is failing and the cause is not obvious.
- Production behavior diverges from local.
- A refactor "shouldn't" have changed behavior but did.
- You are tempted to patch the symptom instead of the cause.

## The loop

```
REPRODUCE -> ISOLATE -> HYPOTHESIZE -> VERIFY -> FIX -> CONFIRM
```

Never skip a step. Skipping is why the same bug comes back.

### 1. Reproduce

Write down the exact steps that trigger the failure. If you cannot reproduce it locally, do not claim a fix. Capture:

- Command or input that triggers the bug.
- Environment (OS, runtime version, branch, commit).
- Full error output, not a paraphrase.

If the bug is intermittent, find the smallest reliable trigger. "It usually fails" is not a repro.

### 2. Isolate

Narrow the scope before touching code. Preferred order:

1. Can you reproduce it in a single file or unit test?
2. Does it reproduce on `main` before your changes?
3. Does it reproduce with a minimal input (bisect the input)?
4. Does it reproduce with a minimal dependency set?

`git bisect` is your friend when the regression started at an unknown commit.

### 3. Hypothesize

State the cause as a falsifiable sentence. Examples:

- "The function returns undefined because input is not awaited."
- "The race condition fires when two writes happen within 50ms."

Avoid "something is wrong with X." That is not a hypothesis, that is a shrug.

### 4. Verify the hypothesis before fixing

Run one experiment that would falsify it. Prints, breakpoints, a failing test, a minimal script. Do not write a fix until the experiment confirms the cause.

If the experiment falsifies the hypothesis, go back to step 3. This is the step most people skip.

### 5. Fix

Make the smallest change that addresses the confirmed cause. Do not combine a fix with an unrelated refactor, it mixes signal.

### 6. Confirm

- Re-run the reproducer. It now passes.
- Run the surrounding test suite. Nothing else broke.
- If you added a regression test, it fails on the old code and passes on the new code.

## Anti-patterns

- Reading code and guessing without a repro.
- Restarting the process and declaring it fixed.
- "Fixing" by removing the assertion.
- Stacking speculative changes until the symptom goes away.
- Claiming a flaky test is "flaky" without finding the race.

## Output template

```
REPRO
- Steps: [numbered]
- Environment: [OS, runtime, commit]
- Error: [verbatim]

HYPOTHESIS
- Cause (falsifiable): [one sentence]
- Evidence that would falsify: [what experiment]

EXPERIMENT
- What was run: [command or test]
- Result: [supports | falsifies] the hypothesis

FIX
- Change: [minimal diff summary]
- Regression test: [path or "not applicable"]

CONFIRM
- Reproducer now passes: [yes]
- Surrounding suite: [pass count]
```
