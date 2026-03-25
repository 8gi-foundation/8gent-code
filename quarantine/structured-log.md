# structured-log

Structured JSON logger with log levels and context.

## Requirements
- Logger class with debug, info, warn, error methods
- Each log outputs JSON: { level, message, timestamp, ...context }
- withContext(fields) -> child logger with merged context
- Level filter: setLevel(level) suppresses below
- Pluggable transport: setTransport(fn)

## Status

Quarantine - pending review.

## Location

`packages/tools/structured-log.ts`
