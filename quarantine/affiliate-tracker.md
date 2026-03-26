# affiliate-tracker

Affiliate and referral program tracker: links, conversions, commissions, and payout summary.

## Requirements
- createAffiliate(tracker, { id, name, commissionRate })
- logConversion(tracker, { affiliateId, orderId, amount })
- calculateCommissions(tracker): { affiliateId, conversions, revenue, commission }[]
- topAffiliates(tracker, n): sorted by commission earned
- renderPayoutReport(tracker): markdown payout summary table

## Status

Quarantine - pending review.

## Location

`packages/tools/affiliate-tracker.ts`
