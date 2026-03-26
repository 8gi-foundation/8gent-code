# subdomain-enumerator

Subdomain brute-force enumerator using a wordlist, returns resolvable subdomains.

## Requirements
- enumerate(domain, wordlist[]): resolves each subdomain and collects hits
- defaultWordlist(): returns built-in 50-entry common subdomain list
- filterAlive(results): returns only resolvable entries
- renderReport(results): list of discovered subdomains with IP addresses

## Status

Quarantine - pending review.

## Location

`packages/tools/subdomain-enumerator.ts`
