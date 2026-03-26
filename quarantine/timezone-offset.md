# timezone-offset

Timezone offset utilities without full tz database.

## Requirements
- offsetToString(minutes) returns '+05:30' style
- stringToOffset(str) parses offset string to minutes
- utcToLocal(date, offsetMinutes) shifts date
- localToUTC(date, offsetMinutes) unshifts date
- isValidOffset(str) validates format

## Status

Quarantine - pending review.

## Location

`packages/tools/timezone-offset.ts`
