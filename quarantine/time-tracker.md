# time-tracker

Time tracking with billing rates, project buckets, and invoice-ready summaries.

## Requirements
- startTimer(projectId): returns entry with start timestamp
- stopTimer(entry): closes entry, returns duration in minutes
- logManual(projectId, startISO, endISO): add manual entry
- summary(entries, rateMap): returns { project, hours, rate, amount }[] and total
- toInvoiceLines(summary): formats for invoice-generator compatibility

## Status

Quarantine - pending review.

## Location

`packages/tools/time-tracker.ts`
