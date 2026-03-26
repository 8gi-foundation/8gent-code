# file-walker

Recursive file system walker with filtering and limiting.

## Requirements
- walk(dir, options?) -> AsyncIterable<string>
- Options: include (glob patterns), exclude, maxDepth, followSymlinks
- walkSync(dir, options?) -> string[]
- Yields absolute paths
- Error callback for permission errors

## Status

Quarantine - pending review.

## Location

`packages/tools/file-walker.ts`
