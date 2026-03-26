# content-calendar

Content calendar generator for a given month with channel slots, themes, and publishing frequency.

## Requirements
- generate(month, year, channels[], postsPerWeek): returns CalendarDay[]
- assignTheme(calendar, weekNumber, theme): sets weekly content theme
- fillSlots(calendar, contentItems[]): distributes content across open slots
- renderCalendar(calendar): ASCII monthly grid with content titles
- exportCSV(calendar): CSV with date, channel, title, status

## Status

Quarantine - pending review.

## Location

`packages/tools/content-calendar.ts`
