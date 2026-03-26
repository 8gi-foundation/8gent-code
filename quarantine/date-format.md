# date-format

Date formatting and parsing with pattern strings (no external libs).

## Requirements
- format(date: Date, pattern: string) -> string
- Patterns: YYYY MM DD HH mm ss SSS ddd DDD
- parse(str: string, pattern: string) -> Date
- relative(date: Date, now?: Date) -> string ('2 hours ago')
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/date-format.ts`
