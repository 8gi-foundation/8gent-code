# draft-review-cycle

State machine for content draft lifecycle: brief -> draft -> review -> revision -> approved -> published.

## Requirements
- transition(state, event): returns next state or throws invalid transition error
- addComment(draft, comment): appends reviewer comment with timestamp and author
- summarizeRevisions(draft): returns diff summary of each revision round
- exportTimeline(draft): chronological log of all state transitions and comments

## Status

Quarantine - pending review.

## Location

`packages/tools/draft-review-cycle.ts`
