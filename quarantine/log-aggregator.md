# log-aggregator

Aggregate structured log lines with level filtering and buffering.

## Requirements
- LogAggregator with level threshold
- add(entry) buffers structured log entry
- flush() returns buffered entries and clears
- filter(level) returns entries at or above level
- toText(entries) formats as plain text lines

## Status

Quarantine - pending review.

## Location

`packages/tools/log-aggregator.ts`
