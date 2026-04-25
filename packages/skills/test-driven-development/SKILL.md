---
name: test-driven-development
description: Write the failing test first, then the smallest code that makes it pass. Use when implementing a feature, fixing a bug, or changing observable behavior.
trigger: /tdd
aliases: [/test-first, /red-green-refactor]
tools: [bash, read, edit, write]
---

# Test-Driven Development

The test is the spec you can run. Write it first so the spec cannot lie about what was actually built.

## When to use

- New feature with observable behavior.
- Bug fix (the test is the regression guard).
- Refactor that changes an interface.
- Any change where "I thought it worked" would cost you later.

## The cycle

```
RED   -> write a test that describes the behavior. Run it. It MUST fail.
GREEN -> write the smallest code that makes the test pass. Nothing more.
REFACTOR -> clean up while tests stay green.
```

Repeat in small steps. Each cycle is minutes, not hours.

### RED

- Name the test after the behavior, not the function. "returns empty list for unknown user", not "testGetUser2".
- Assert one thing. Multiple assertions in one test hide which one failed.
- Run the test. Confirm it fails for the right reason (the feature is missing, not a typo). If it passes on red, your test is wrong.

### GREEN

- Write the minimum that makes this single test pass. Hardcode if you must, the next test will force generality.
- Resist adding code for tests you have not written yet.
- Run the full test file. New test passes, nothing else broke.

### REFACTOR

- Remove duplication you just introduced.
- Rename to clarify intent.
- Do not change behavior. If you did, a test should have caught it, and you are really in a new RED cycle.

## Bug-fix TDD

When fixing a bug, write the test that reproduces it before touching the code.

1. Write a test that asserts the correct behavior.
2. Run it. Confirm it fails with the bug's signature.
3. Fix the code.
4. The test now passes. Commit both.

This gives you a regression test for free and proves the fix addressed the reported bug.

## What a good test looks like

- Runs in under 100ms when possible.
- Does not depend on other tests (order-independent).
- Uses real inputs from the bug report or spec, not "foo" and "bar".
- Fails with a message that points at the cause, not "expected true, got false".

## What to skip

- Do not TDD throwaway scripts or one-shot data migrations.
- Do not TDD pure presentational tweaks where the test is "it compiles".
- Do not write tests for framework behavior you do not own.

## Output template

```
BEHAVIOR
- One-line description of what should work.

RED
- Test name: [descriptive]
- Command: [runner invocation]
- Result: FAILED (as expected)

GREEN
- Change summary: [1-3 lines]
- Command: [same]
- Result: PASSED

REFACTOR
- Cleanups: [list or "none needed"]
- Command: [same]
- Result: PASSED
```

## Anti-patterns

- Writing the test after the code. That is not TDD, that is coverage theater.
- Giant tests that cover ten behaviors. Split them.
- Skipping the RED step. If you never saw it fail, you do not know it works.
- Mocking everything. Tests become trivially green and prove nothing.
