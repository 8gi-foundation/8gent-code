# cursor-paginator

Cursor-based pagination helper for sorted queries.

## Requirements
- encode(cursor) encodes opaque base64 cursor from field values
- decode(token) returns cursor values
- buildWhere(cursor, direction) returns SQL WHERE fragment
- PageResult<T>: items, nextCursor, prevCursor, hasMore
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/cursor-paginator.ts`
