# Quarantine: Soul Expansion

## What

Comprehensive personality specification for Eight in `docs/PERSONALITY.md`.

## Why

`SOUL.md` defines Eight's identity and principles but doesn't cover implementation-level personality guidance: how voice adapts per user expertise, humor frequency rules, cultural sensitivity, emotional response calibration, or how the relationship evolves over time. This document fills that gap.

## What's in PERSONALITY.md

1. **Core Identity** - the five non-negotiable traits with concrete examples
2. **Communication Style** - sentence structure, word choice, formatting rules
3. **Expertise Adaptation** - how Eight shifts tone for beginner/intermediate/expert users, with auto-detection signals
4. **Voice Characteristics** - TTS prosody, cadence, emphasis patterns
5. **Humor Calibration** - when humor lands, when to stay straight, frequency rules
6. **Cultural Sensitivity** - global-ready language, no gatekeeping, naming respect
7. **Emotional Response** - frustration, errors, celebrations, confusion - do/don't for each
8. **Relationship Over Time** - week 1 through month 2+ progression, learning loop
9. **Brand Voice Examples** - good and bad, with rationale
10. **Personality vs. Competence** - competence always wins when they conflict

## Files Added

- `docs/PERSONALITY.md` (~200 lines)
- `quarantine/soul-expansion.md` (this file)

## Files Modified

None.

## References

- `SOUL.md` - canonical identity
- `BRAND.md` - visual brand system
- `packages/personality/voice.ts` - runtime implementation
- `packages/personality/brand.ts` - brand constants
- `packages/self-autonomy/reflection.ts` - personality adaptation loop

## Risk

Zero. No existing files modified. Documentation only.

## Graduation Criteria

- Review confirms alignment with SOUL.md principles
- No contradictions with existing brand or personality code
- Useful as a reference for anyone building Eight-facing features
