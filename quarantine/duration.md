# duration

Parse and format human-readable durations (e.g. '2h 30m', '90s').

## Requirements
- parse(str: string) -> number (milliseconds)
- format(ms: number, precision?: number) -> string
- Support years, weeks, days, hours, minutes, seconds, ms
- humanize(ms) -> '2 hours' using largest unit
- add(ms1, ms2) and subtract(ms1, ms2) helpers

## Status

Quarantine - pending review.

## Location

`packages/tools/duration.ts`
