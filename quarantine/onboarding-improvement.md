# Onboarding Improvement - Quarantine Spec

Status: quarantine (not yet implemented)
Related: `packages/self-autonomy/onboarding.ts`
Benchmark: `benchmarks/categories/abilities/onboarding-quality.ts`

## Problem

The onboarding system works but has gaps that the new benchmark exposes. This document captures improvement opportunities discovered through benchmark design.

## Current State

- `OnboardingManager` handles a 3-question flow (identity, communication, agent naming) plus voice selection and confirmation
- `autoDetect()` reads git config, ollama models, and GitHub CLI auth
- `calculateConfidence()` scores user understanding from 0 to 1
- User config persists to `.8gent/user.json`

## Gaps Found

### 1. No OS/Shell/Editor Detection

`autoDetect()` reads git, ollama, and GitHub but does not detect:
- Operating system (darwin/linux/win32) - trivially available via `process.platform`
- Shell (zsh/bash/fish) - available via `$SHELL` env var
- Editor (VS Code/Vim/Emacs) - detectable via `$EDITOR` or `which code`

These affect how 8gent generates commands and file paths.

**Fix:** Add `os`, `shell`, `editor` fields to `AutoDetected` interface and detect them in `autoDetect()`.

### 2. No Expertise-Based Adaptation

The `communicationStyle` field exists but nothing in the system adapts behavior based on it combined with `confidenceScore`. A beginner with 2 interactions should get more hand-holding than an expert with 200.

**Fix:** Add an `adaptBehavior(user: UserConfig)` function that returns runtime hints:
- `verbosity: 'full' | 'normal' | 'terse'`
- `confirmBeforeAction: boolean`
- `showExplanations: boolean`

### 3. Confidence Score Stagnation

`calculateConfidence()` caps interaction-based growth at `promptCount / 50`. After 50 prompts the score stops growing. Users who stay for 500 sessions get no additional confidence credit.

**Fix:** Use a logarithmic curve instead of linear cap: `Math.min(Math.log10(promptCount + 1) / 2, 0.2)`.

### 4. Duplicate Step Keys in Voice Questions

Two `ONBOARDING_QUESTIONS` entries both use `step: "voice"`. The `getNextQuestion()` method skips by step name, so after answering the first voice question the second is auto-skipped.

**Fix:** Split into `"agent-name"` and `"voice-selection"` step keys.

### 5. No Onboarding Analytics

There is no record of how long onboarding took, how many questions were skipped, or whether the user completed the full flow vs bailing early.

**Fix:** Add `onboardingMeta` to `UserConfig`:
- `startedAt: string`
- `completedAt: string | null`
- `questionsSkipped: number`
- `totalDurationMs: number`

## Estimated Scope

| Change | Files touched | Lines added |
|--------|--------------|-------------|
| OS/shell/editor detection | 1 | ~20 |
| Expertise adaptation | 1 | ~30 |
| Confidence curve fix | 1 | ~5 |
| Voice step key split | 1 | ~10 |
| Onboarding analytics | 1 | ~25 |

All changes are in `packages/self-autonomy/onboarding.ts`. Total: ~90 lines added to 1 file.

## Success Metric

The `onboarding-quality.ts` benchmark (AB008) should pass at 80%+ with a capable model after these improvements are applied. Currently the benchmark tests against the documented behavior, so it serves as both a regression test and a target.

## Not Doing

- Rewriting the onboarding UI (that lives in the TUI layer)
- Adding new onboarding questions beyond the current flow
- Cloud sync of onboarding state (that's in `preferences-sync.ts`)
- Multi-language onboarding prompts
