# cookie-security-auditor

Audits Set-Cookie headers for security flags: HttpOnly, Secure, SameSite, Path, Max-Age.

## Requirements
- parseCookie(setCookieHeader): returns { name, value, flags{} }
- audit(cookie): returns { issues[], score } checking for missing security flags
- scanHeaders(headers[]): audits all Set-Cookie headers in a response
- renderReport(results): markdown cookie security report per cookie name

## Status

Quarantine - pending review.

## Location

`packages/tools/cookie-security-auditor.ts`
