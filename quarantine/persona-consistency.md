# Persona Consistency Benchmark - Test Design

**File:** `benchmarks/categories/abilities/persona-consistency.ts`
**Tests:** `packages/personality/` + `packages/self-autonomy/onboarding.ts`

## Problem

No automated test validates that Eight maintains consistent "Infinite Gentleman" brand voice across turns, adapts communication based on user expertise, or correctly surfaces stored user preferences in responses.

## What it tests

| # | Scenario | What it proves |
|---|----------|---------------|
| 1 | Brand voice greeting | Agent uses refined/distinguished vocabulary from `packages/personality/voice.ts` - not generic bot speak |
| 2 | Expertise adaptation | Agent adjusts depth based on `communicationStyle` and `role` from `UserConfig` (onboarding.ts) |
| 3 | Preference recall | Agent correctly references stored project/preferences from the user config |
| 4 | Multi-turn consistency | Voice does not drift or reset between completion and follow-up messages |

## What it does NOT test

- Persona mutation via `PersonaMutator` (SOUL.md calibration changes)
- Voice TTS output (macOS `say` command)
- Onboarding flow UX (interactive question sequence)
- Status verb cycling during processing

## Packages exercised

- `packages/personality/voice.ts` - PERSONALITY traits, GREETINGS, COMPLETION_PHRASES, REFINED_TRANSITIONS
- `packages/personality/brand.ts` - BRAND identity, tagline
- `packages/self-autonomy/onboarding.ts` - UserConfig, CommunicationStyle, preference storage
- `packages/self-autonomy/persona-mutation.ts` - PersonaParameter calibration (indirectly, via brand voice expectations)

## How to run

```bash
bun run benchmarks/categories/abilities/persona-consistency.ts
```

Or via the harness:

```bash
CATEGORY=abilities bun run benchmark:v2
```

## Scoring

Uses AI judge evaluation (no string matching, per CLAUDE.md rules). Four dimensions weighted:

| Dimension | Weight | What the judge looks for |
|-----------|--------|------------------------|
| brand_voice_present | 30% | Distinguished vocabulary, gentleman persona, no em dashes |
| expertise_adaptation_correct | 25% | Concise response for senior engineer, no hand-holding |
| preference_recall_accurate | 20% | Correctly states "payment-service" from stored config |
| multi_turn_consistency | 25% | Same voice register across completion + follow-up |

## Success criteria

All 12 criteria pass via AI judge. The judge prompt is embedded in the benchmark file to ensure semantic evaluation rather than brittle pattern matching.

## Design decisions

- Single prompt with 4 labeled scenarios avoids multi-turn harness complexity.
- Judge prompt included in the benchmark object so any harness can use it.
- Tests the intersection of personality + onboarding (brand voice + user context).
- Under 120 lines for the benchmark file.
- No external dependencies - the benchmark is a prompt + scoring spec.
