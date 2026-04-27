# headline-scorer

Scores headlines for emotional value, power words, clarity, and SEO using rule-based analysis.

## Requirements
- score(headline): returns { overall, emotional, clarity, seo, wordCount }
- powerWords(): built-in list of 100+ high-impact words
- analyze(headline): returns { issues[], suggestions[], score }
- compare(headlines[]): ranks headlines by score
- optimize(headline): returns improved headline suggestion

## Status

Quarantine - pending review.

## Location

`packages/tools/headline-scorer.ts`
