# structured-output

Parse and validate LLM structured output (JSON mode).

## Requirements
- extract(text) pulls JSON from markdown code blocks or raw text
- parse<T>(text, schema) validates against JSON schema
- repair(text) attempts to fix truncated JSON
- isComplete(json) checks for balanced braces
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/structured-output.ts`
