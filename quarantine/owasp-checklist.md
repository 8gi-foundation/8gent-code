# owasp-checklist

OWASP Top 10 compliance checklist generator with risk descriptions and remediation guidance.

## Requirements
- getChecklist(): returns all 10 items with description, risk, and remediation
- markItem(checklist, id, status): status is pass | fail | na | todo
- complianceScore(checklist): percent of non-na items passing
- renderReport(checklist): markdown checklist with status icons and remediations
- exportJSON(checklist): structured compliance data

## Status

Quarantine - pending review.

## Location

`packages/tools/owasp-checklist.ts`
