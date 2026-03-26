# token-budget-calculator

Calculates token budgets for multi-part prompts: system, history, context, and output reservation.

## Requirements
- allocate(totalLimit, { system, history, context, outputReserve }): proportional allocation
- remaining(total, used, reserved): available tokens for content
- estimateTokens(text): character-based approximation (chars/4)
- fitWithinBudget(sections{}, budget): trims longest sections first to fit
- renderBudget(allocation): table of sections with token counts and percents

## Status

Quarantine - pending review.

## Location

`packages/tools/token-budget-calculator.ts`
