# usp-extractor

Extracts and ranks unique selling propositions from product descriptions or feature lists.

## Requirements
- extract(text): returns USP candidates as bullet points
- rank(usps[], competitorFeatures[]): sorts by uniqueness against competitor list
- elevatorPitch(usps[], audience): generates a 30-second pitch from top USPs
- validateUSP(usp): checks for vague language, buzzwords, and specificity score

## Status

Quarantine - pending review.

## Location

`packages/tools/usp-extractor.ts`
