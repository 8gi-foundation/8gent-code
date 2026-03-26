# tls-config-auditor

TLS configuration auditor that evaluates cipher suites, protocol versions, and HSTS policy.

## Requirements
- auditConfig({ protocols[], ciphers[], hstsMaxAge, ocspStapling })
- flagWeakCiphers(ciphers[]): identifies RC4, DES, 3DES, EXPORT ciphers
- flagOldProtocols(protocols[]): flags TLS 1.0, 1.1, SSL 2/3
- score(audit): 0-100 TLS quality score
- renderReport(audit): markdown TLS audit report with A/B/C/F grade

## Status

Quarantine - pending review.

## Location

`packages/tools/tls-config-auditor.ts`
