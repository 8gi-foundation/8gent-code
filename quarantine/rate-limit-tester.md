# rate-limit-tester

Rate limit bypass technique tester that simulates common bypass patterns and reports effectiveness.

## Requirements
- techniques(): returns list of bypass techniques: IP rotation, header spoofing, path variation
- analyzeHeaders(headers{}): detects rate limit header patterns (X-RateLimit-*, Retry-After)
- parseRateLimitHeaders(headers{}): extracts limit, remaining, reset values
- renderReport(analysis): markdown report with detected limits and bypass surface

## Status

Quarantine - pending review.

## Location

`packages/tools/rate-limit-tester.ts`
