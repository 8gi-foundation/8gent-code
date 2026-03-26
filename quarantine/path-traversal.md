# path-traversal

Detect and block path traversal attacks in file paths.

## Requirements
- isSafe(userPath, root) returns false if path escapes root
- sanitize(userPath, root) returns resolved path or throws
- detect(path) returns array of suspicious patterns found
- normalize(path) resolves .., ., and double slashes
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/path-traversal.ts`
