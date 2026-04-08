# deep-validate

Deeply validate object trees with path-based error reporting.

## Requirements
- Validator<T>(rules) with validate(obj) method
- Rule: (value, path) => string | null (returns error or null)
- Collects all errors before returning
- errors array: {path, message} objects
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/deep-validate.ts`
