# research-integrity

Research integrity validator - enforces URL-or-it-didnt-happen rules on any text claiming facts or citing sources

## Requirements
- Export validateIntegrity(text) returning { valid: boolean, issues: IntegrityIssue[] }
- Detect claims without URLs, fabricated-looking URLs, dead URL patterns, summary-without-source patterns
- Severity levels: FATAL (fabricated source), MAJOR (claim without citation), MINOR (incomplete reference)
- Export integrityRules as typed constants for use in agent system prompts

## Status

Quarantine - pending review.

## Location

`packages/tools/research-integrity.ts`
