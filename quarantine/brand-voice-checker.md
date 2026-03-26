# brand-voice-checker

Checks copy against a defined brand voice profile for tone consistency.

## Requirements
- defineVoice({ traits[], avoidWords[], preferWords[], sentenceLength })
- analyzeText(voice, text): returns { score, violations[], suggestions[] }
- scoreReadability(text): Flesch-Kincaid grade level
- highlightViolations(voice, text): returns text with violation markers

## Status

Quarantine - pending review.

## Location

`packages/tools/brand-voice-checker.ts`
