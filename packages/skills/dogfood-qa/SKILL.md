---
name: dogfood-qa
description: 8gent's QA workflow for systematic exploration and bug reporting. Apply when asked to QA, dogfood, test, or find issues in a TUI or web interface.
type: skill
---

# Dogfood QA

Systematic exploration of every UI surface. Repro-first. Evidence for every finding.

## Priority Levels

| Level | Definition |
|-------|-----------|
| P0 | Crash, hang, data loss, security breach |
| P1 | Core feature broken, no workaround |
| P2 | Broken UX, has workaround |
| P3 | Cosmetic, typo, minor misalignment |

Aim for 5-10 well-documented issues. Depth of evidence beats issue count.

## Workflow

```
1. Orient     - Understand the app structure before diving in
2. Explore    - Visit every surface systematically
3. Document   - Repro immediately when an issue is found
4. Wrap up    - Severity counts, summary, next steps
```

### 1. Orient

- Take an initial screenshot of the starting state.
- Map the main navigation and list sections to visit.
- Note the terminal size / viewport for TUI work.

### 2. Explore

Work through the app top-to-bottom, feature-by-feature:
- Visit every top-level navigation section.
- Test interactive elements: buttons, inputs, dropdowns, modals, keyboard shortcuts.
- Try edge cases: empty state, long input, special characters, rapid clicks.
- Run end-to-end workflows: create, edit, delete.
- Check console/logs for errors after each interaction.

For TUI specifically:
- Test at narrow (80 col), standard (120 col), and wide (160+ col) terminal widths.
- Test at short (24 row) and tall (50+ row) terminal heights.
- Verify all keyboard navigation paths work (tab, arrow keys, enter, esc).
- Test screen reader output if applicable.

### 3. Document Issues (Repro-First)

Document immediately when found. Never batch for later.

Every issue requires:
- **Title**: Short, active voice ("Submit button crashes on empty input")
- **Priority**: P0-P3
- **Steps to reproduce**: Numbered, specific
- **Expected**: What should happen
- **Actual**: What actually happens
- **Evidence**: Screenshot for static issues, recording for interactive issues

Interactive/behavioral issues - full repro:
1. Start recording before reproducing.
2. Step through at human pace (pause between actions).
3. Capture broken state with annotated screenshot.
4. Stop recording.
5. Write numbered steps referencing screenshots.

Static issues (typo, misalignment, wrong color) - single annotated screenshot is enough. No video needed.

Increment issue counter: ISSUE-001, ISSUE-002, ...

### 4. Wrap Up

- Update severity counts to match actual issues found.
- Summarize: total issues, breakdown by priority, top P0/P1 findings.
- Close session / reset state.

## Rules

- Repro is everything. If you can't reproduce it, don't report it.
- Screenshot each step for interactive issues. Label them step-1, step-2, result.
- Check keyboard navigation on every interactive element.
- Never read the target app's source code during QA — test as a user.
- Never delete output files mid-session. Work forward.
- Write findings as you go. If session is interrupted, findings are preserved.

## Checklist

- [ ] All navigation sections visited
- [ ] Empty states tested
- [ ] Error states triggered
- [ ] Keyboard-only navigation verified
- [ ] Multiple terminal sizes tested (TUI)
- [ ] Console/logs checked for silent errors
- [ ] End-to-end workflows completed (create, edit, delete)
- [ ] Every issue has repro steps and evidence
