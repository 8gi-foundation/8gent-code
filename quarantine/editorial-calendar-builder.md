# editorial-calendar-builder

Editorial calendar builder with themes, formats, channels, and assignment tracking.

## Requirements
- createCalendar(period, channels[])
- addEntry(calendar, { date, channel, format, title, author, status })
- assignEntry(calendar, id, author)
- overdue(calendar, now?): entries past due date without published status
- renderCalendar(calendar): ASCII monthly editorial grid

## Status

Quarantine - pending review.

## Location

`packages/tools/editorial-calendar-builder.ts`
