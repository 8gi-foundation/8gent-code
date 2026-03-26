# sqli-pattern-detector

SQL injection pattern detector that scans input strings for common injection payloads.

## Requirements
- detect(input): returns { detected, patterns[], severity }
- patterns: UNION SELECT, OR 1=1, comment sequences (--, #), stacked queries (;)
- scan(inputs{}): scans all form fields, returns per-field results
- renderReport(results): table of field, input, detected patterns
- sanitizeHint(pattern): suggests parameterized query fix

## Status

Quarantine - pending review.

## Location

`packages/tools/sqli-pattern-detector.ts`
