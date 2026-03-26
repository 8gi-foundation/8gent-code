# email-sequence-builder

Drip campaign email sequence builder with delay scheduling, A/B variants, and goal tracking.

## Requirements
- addEmail(sequence, { subject, body, delayDays, goal })
- addVariant(email, variant): A/B variant for subject or body
- generateSchedule(sequence, startDate): returns array of { date, emailId }
- validateSequence(sequence): checks for gaps, missing goals, duplicate subjects
- renderPreview(email): plain text preview with metadata

## Status

Quarantine - pending review.

## Location

`packages/tools/email-sequence-builder.ts`
