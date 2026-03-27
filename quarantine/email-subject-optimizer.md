# email-subject-optimizer

Email subject line optimizer scoring for open rate potential, spam triggers, and personalization.

## Requirements
- score(subject): returns { openRate, spamRisk, length, hasPersonalization }
- spamTriggers(): built-in list of 50+ spam trigger words
- optimize(subject): returns improved subject line suggestions
- abVariants(subject, n): generates N A/B test variants
- compare(subjects[]): ranks by predicted open rate

## Status

Quarantine - pending review.

## Location

`packages/tools/email-subject-optimizer.ts`
