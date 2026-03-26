# churn-predictor

Rule-based churn risk scorer using recency, frequency, and engagement signals.

## Requirements
- scoreCustomer({ lastActiveDate, sessionsLast30d, supportTickets, planAge }): returns 0-100 risk score
- classify(score): returns low | medium | high | critical
- batchScore(customers[]): returns sorted risk list
- topChurnRisks(customers[], n): returns top N at-risk customers with scores

## Status

Quarantine - pending review.

## Location

`packages/tools/churn-predictor.ts`
