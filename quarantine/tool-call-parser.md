# tool-call-parser

Parse LLM tool call responses from raw text.

## Requirements
- parse(text) extracts tool calls from JSON blocks
- ToolCall: {name, arguments, id}
- parseMultiple(text) returns all tool calls in order
- validate(call, schema) checks arguments against JSON schema
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/tool-call-parser.ts`
