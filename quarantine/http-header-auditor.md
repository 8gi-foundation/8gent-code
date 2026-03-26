# http-header-auditor

Analyzes HTTP response headers for security best practices and OWASP recommendations.

## Requirements
- audit(headers{}): returns { present[], missing[], misconfigured[], score }
- checkHeader(name, value): validates individual header value correctness
- CHECKS: X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- renderReport(audit): markdown report with pass/fail per header and remediation

## Status

Quarantine - pending review.

## Location

`packages/tools/http-header-auditor.ts`
