# proposal-writer

Structured proposal generator covering executive summary, scope, timeline, pricing, and terms.

## Requirements
- buildProposal({ client, project, phases, pricing, terms }): returns Proposal object
- renderMarkdown(proposal): full markdown document with sections
- estimateTotalPrice(phases): sums phase costs with optional margin percentage
- generateTimeline(phases): returns ordered milestones with ISO dates

## Status

Quarantine - pending review.

## Location

`packages/tools/proposal-writer.ts`
