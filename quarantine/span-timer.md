# span-timer

Measure elapsed time for named spans with nesting.

## Requirements
- startSpan(name) returns Span with end() method
- getSpans() returns completed spans array
- Span: {name, startMs, durationMs}
- reset() clears spans
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/span-timer.ts`
