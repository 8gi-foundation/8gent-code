# okr-tracker

OKR framework: objectives with key results, scoring (0.0-1.0), and progress reporting.

## Requirements
- addObjective(tracker, { title, quarter })
- addKeyResult(objectiveId, { title, target, current, unit })
- score(keyResult): returns 0.0-1.0 based on current/target
- objectiveScore(objective): average score of all key results
- renderReport(tracker): markdown OKR report with scores and RAG status

## Status

Quarantine - pending review.

## Location

`packages/tools/okr-tracker.ts`
