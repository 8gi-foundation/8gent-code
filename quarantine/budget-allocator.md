# budget-allocator

Marketing or project budget allocator with channel weightings, caps, and scenario modeling.

## Requirements
- allocate(totalBudget, channels[], weights{}): distributes budget proportionally
- applyCap(allocation, channelId, maxAmount): respects per-channel caps
- scenario(budget, scenarios{}): runs multiple allocation scenarios side by side
- renderBreakdown(allocation): ASCII bar chart of budget distribution

## Status

Quarantine - pending review.

## Location

`packages/tools/budget-allocator.ts`
