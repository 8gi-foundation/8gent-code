# function-schema

Generate JSON Schema from TypeScript-style function signatures.

## Requirements
- FunctionParam: name, type, description, required
- buildSchema(name, description, params) returns OpenAI function schema
- toZodShape(params) returns Zod-compatible shape object
- validate(args, schema) checks args against schema
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/function-schema.ts`
