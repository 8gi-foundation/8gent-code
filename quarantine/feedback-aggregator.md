# feedback-aggregator

Aggregates qualitative feedback from multiple sources into themes with frequency and sentiment.

## Requirements
- addFeedback(pool, { text, source, date, rating? })
- clusterByKeyword(pool, keywords[]): groups feedback by matching keywords
- sentimentSummary(pool): positive/neutral/negative counts from rating or heuristic
- topThemes(pool, n): returns most frequent themes with example quotes
- renderReport(pool): markdown report with themes and sample feedback

## Status

Quarantine - pending review.

## Location

`packages/tools/feedback-aggregator.ts`
