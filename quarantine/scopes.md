# scopes

OAuth-style permission scope parser and validator.

## Requirements
- parse(scopeString) returns string[] from space-delimited string
- hasScope(granted, required) checks subset
- hasAnyScope(granted, anyOf) checks intersection
- expand(scope, definitions) expands wildcard scopes
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/scopes.ts`
