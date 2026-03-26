# trace-context

W3C Trace Context (traceparent/tracestate) propagation.

## Requirements
- generate() creates new trace and span IDs
- parse(header) parses traceparent header
- format(trace) returns traceparent string
- child(parent) creates child span from parent
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/trace-context.ts`
