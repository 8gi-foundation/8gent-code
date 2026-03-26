# glob-expand

Expand glob patterns to file path lists (pure string matching).

## Requirements
- match(pattern, paths[]) returns matching paths
- Supports * (any chars), ** (any segments), ? (one char)
- negate(pattern, paths[]) returns non-matching paths
- isGlob(str) detects if string contains glob chars
- Zero dependencies, no filesystem access

## Status

Quarantine - pending review.

## Location

`packages/tools/glob-expand.ts`
