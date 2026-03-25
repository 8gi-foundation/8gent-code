# env-reader

Type-safe environment variable reader with validation.

## Requirements
- env(key: string) -> EnvValue with .string(), .number(), .boolean(), .required()
- Load from process.env and optional .env file
- default(val) for fallback
- validate(fn) for custom validation
- Collect all errors before throwing (no fail-fast)

## Status

Quarantine - pending review.

## Location

`packages/tools/env-reader.ts`
