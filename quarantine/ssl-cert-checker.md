# ssl-cert-checker

SSL certificate inspector: expiry, issuer, SANs, chain validity, and cipher suite check.

## Requirements
- parseCertInfo(pemString): returns { subject, issuer, validFrom, validTo, sans[], serial }
- daysUntilExpiry(cert): number of days remaining
- isExpired(cert): boolean
- checkChain(certs[]): validates issuer chain is unbroken
- renderSummary(cert): formatted certificate summary

## Status

Quarantine - pending review.

## Location

`packages/tools/ssl-cert-checker.ts`
