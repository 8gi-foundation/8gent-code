# meeting-notes-summarizer

Parses raw meeting notes to extract decisions, action items, owners, and deadlines.

## Requirements
- parse(text): returns { attendees, decisions[], actions[], blockers[] }
- extractActions(text): returns array of { task, owner, deadline }
- formatSummary(parsed): clean markdown summary
- detectBlockers(text): identifies BLOCKED/blocker keywords with context
- exportTasks(parsed): returns action items as a checklist

## Status

Quarantine - pending review.

## Location

`packages/tools/meeting-notes-summarizer.ts`
