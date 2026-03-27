# copy-tone-adjuster

Adjusts copy tone from formal to casual, aggressive to gentle, using rule-based word substitution.

## Requirements
- defineToneMap(from, to, substitutions{}): word/phrase replacement rules
- adjust(text, toneMap): applies substitutions preserving structure
- formalToInformal(text): built-in formal -> casual transformation
- activeVoice(text): converts passive voice patterns to active
- renderDiff(original, adjusted): side-by-side tone comparison

## Status

Quarantine - pending review.

## Location

`packages/tools/copy-tone-adjuster.ts`
