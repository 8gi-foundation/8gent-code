# retainer-tracker

Monthly retainer tracker: hours allocated, hours used, overage warnings, and billing summary.

## Requirements
- createRetainer({ client, monthlyHours, hourlyRate, month })
- logHours(retainer, { date, description, hours })
- status(retainer): returns { used, remaining, overage, utilizationPercent }
- renderStatement(retainer): formatted monthly statement with line items
- warnOverage(retainer, threshold): triggers warning at threshold% utilization

## Status

Quarantine - pending review.

## Location

`packages/tools/retainer-tracker.ts`
