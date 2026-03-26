# clickjacking-detector

Detects clickjacking vulnerability by analyzing X-Frame-Options and CSP frame-ancestors.

## Requirements
- analyze(headers{}): returns { protected, method, issues[] }
- checkXFO(value): validates X-Frame-Options is DENY or SAMEORIGIN
- checkCSPFrameAncestors(csp): parses frame-ancestors directive
- renderReport(analysis): markdown report with protection status and recommendations

## Status

Quarantine - pending review.

## Location

`packages/tools/clickjacking-detector.ts`
