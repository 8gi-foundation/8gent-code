# launch-checklist

Product or campaign launch checklist engine with phases, owners, and completion tracking.

## Requirements
- createChecklist(phases[], items[]): structured launch plan
- complete(checklist, itemId): marks item done with timestamp
- readinessScore(checklist): percent of items complete overall and per phase
- blockers(checklist): items in critical phase that are incomplete
- renderMarkdown(checklist): full checklist document with status indicators

## Status

Quarantine - pending review.

## Location

`packages/tools/launch-checklist.ts`
