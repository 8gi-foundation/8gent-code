# dns-inspector

DNS record inspector supporting A, AAAA, MX, TXT, NS, CNAME, and SOA lookups with TTL.

## Requirements
- lookup(domain, type): returns DNS records using Node dns module
- lookupAll(domain): fetches all common record types in parallel
- checkSPF(domain): parses TXT record for SPF policy
- checkDMARC(domain): parses _dmarc TXT record
- renderReport(results): formatted DNS audit table

## Status

Quarantine - pending review.

## Location

`packages/tools/dns-inspector.ts`
