# error-code

Typed error code system with metadata.

## Requirements
- ErrorCode registry with code, message, httpStatus
- AppError class extends Error with code property
- create(code, detail?) creates AppError
- isAppError(err) type guard
- toJSON(err) returns serializable object

## Status

Quarantine - pending review.

## Location

`packages/tools/error-code.ts`
