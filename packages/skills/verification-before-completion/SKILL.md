---
name: verification-before-completion
description: Run a verification command and read its output before claiming work is complete, fixed, or passing. Use before committing, opening a PR, or reporting done.
trigger: /verify
aliases: [/vbc, /confirm-done]
tools: [bash]
---

# Verification Before Completion

"Done" is not a feeling. It is an observation backed by an artifact. Never report completion without an artifact the user can check.

## When to use

- About to say "done", "fixed", "passing", "deployed", or "shipped".
- About to commit, push, or open a PR.
- About to hand work off to another agent or human.

## The rule

Every completion claim names a verification command and the specific output that proves it.

## Required evidence by task type

| Task | Verification | Artifact |
|------|--------------|----------|
| Code change | Test suite or script | `PASS` line, exit 0 |
| Bug fix | Reproducer that used to fail | Reproducer passes, suite green |
| New feature | A test or live invocation | Test pass, URL, or transcript |
| Refactor | Before/after test run | Same test set green both times |
| Deploy | HTTP 200 on live URL | `curl -I` output or screenshot |
| Docs | Render check | Build passes, link check clean |
| CLI behaviour | Invoke the CLI | Actual terminal output |

## The verification loop

```
1. State what "done" means in one sentence.
2. Pick the smallest command that proves it.
3. Run it. Capture stdout and exit code.
4. Read the output. Do not skim.
5. Report: command, exit code, relevant line.
```

If the command failed, you are not done. Do not proceed to commit or report.

## Honesty rules

- Never claim a deploy without an HTTP check against the live URL.
- Never claim a fix without rerunning the reproducer that used to fail.
- Never claim "all tests pass" if you only ran one file. Say which you ran.
- Never claim "should work" as a substitute for "here is the run".
- If the verification command does not exist yet, write it first, then run it.

## Output template

```
COMPLETION CLAIM
- What: [one sentence]

VERIFICATION
- Command: [exact command]
- Exit code: [number]
- Key output:
    [1-3 lines that prove it]

STATUS
- [ ] Command ran locally
- [ ] Exit code is 0 (or expected non-zero)
- [ ] Output matches the claim
```

## Anti-patterns

- "Tests should pass" instead of "tests pass, here is the log".
- "Deployed" based on a build log, no live HTTP check.
- "Fixed" based on reading the diff, not running it.
- Claiming green CI without linking the run.

## Principle alignment

- Evidence, not enthusiasm.
- Ship what works, not what you hope works.
- Verification is cheap. False completion is expensive.
