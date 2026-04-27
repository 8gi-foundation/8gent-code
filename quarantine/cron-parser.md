# cron-parser

Cron expression parser and validator with next-run calculation and human description.

## Requirements
- parse(expression): returns { minute, hour, day, month, weekday } as arrays
- validate(expression): returns { valid, errors[] }
- nextRun(expression, from?): returns next Date matching the expression
- describe(expression): returns human-readable description
- upcomingRuns(expression, n, from?): returns next N scheduled dates

## Status

Quarantine - pending review.

## Location

`packages/tools/cron-parser.ts`
