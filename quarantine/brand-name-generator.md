# brand-name-generator

Generates brand name candidates from keywords using morphological patterns and checks.

## Requirements
- generate(keywords[], options?): returns 20+ name candidates
- patterns: compound, portmanteau, initialism, metaphor, truncation
- score(name): scores on memorability, pronounceability, domain-friendliness
- filter(names[], domainSuffix?): filters for likely-available domains
- renderReport(names[]): scored brand name shortlist

## Status

Quarantine - pending review.

## Location

`packages/tools/brand-name-generator.ts`
