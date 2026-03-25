# Quarantine: GitHub Bounty Scanner

## Problem

Eight needs to autonomously discover work opportunities on GitHub - specifically issues with bounties, "good first issue", and "help wanted" labels that match its TypeScript/Bun/React/CLI skill set.

## Approach

New file: `packages/proactive/issue-scanner.ts` (~150 lines)

### How it works

1. **Search** - Runs 5 targeted GitHub Search API queries focusing on TypeScript issues with opportunity labels (good first issue, help wanted, bounty).

2. **Deduplicate** - Issues appear in multiple queries. Deduped by URL before scoring.

3. **Filter** - Each issue is checked against Eight's capability map via the existing `evaluateOpportunity()` from `capability-matcher.ts`. Issues that don't match are rejected.

4. **Score** - Combined score (0-1) weighted:
   - 40% skill keyword relevance (typescript, bun, react, cli, etc.)
   - 30% complexity estimate (simpler = higher score)
   - 20% capability matcher score (existing evaluator)
   - 10% bounty value bonus (normalized at $500 cap)

5. **Digest** - `dailyDigest()` returns top N opportunities sorted by score. `formatDigest()` renders plain text for CLI/Telegram output.

### Integration points

- **Daemon cron**: Call `dailyDigest()` on a 24h interval from the daemon scheduler.
- **Existing proactive pipeline**: Uses same `Opportunity` type and `evaluateOpportunity()` from capability-matcher.
- **Work tracker**: Output can be piped into `trackAll()` from work-tracker.ts.

### What this does NOT do

- Does not auto-submit PRs or claim issues.
- Does not use an LLM for scoring (pure keyword + label heuristics).
- Does not modify any existing files.

### Rate limits

GitHub Search API allows 10 requests/minute unauthenticated, 30/minute with a PAT. The scanner runs 5 queries per invocation, well within limits for daily use.

## Validation

- Manually run `dailyDigest()` and verify top 5 results are TypeScript issues with approachable labels.
- Confirm score ordering makes sense (bounty issues and simple TS issues rank higher).

## Files

| File | Action | Lines |
|------|--------|-------|
| `packages/proactive/issue-scanner.ts` | New | ~150 |
| `quarantine/github-bounty-scanner.md` | New | This file |
