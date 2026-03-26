# idor-pattern-scanner

Scans API route definitions for Insecure Direct Object Reference (IDOR) anti-patterns.

## Requirements
- scanRoutes(routes[]): flags routes with user-controlled ID params without auth middleware
- patternMatch(route): detects GET /resource/:id, /users/:userId patterns
- renderReport(results): markdown report with IDOR risk per route
- remediation(route): generates recommendation for ownership check

## Status

Quarantine - pending review.

## Location

`packages/tools/idor-pattern-scanner.ts`
