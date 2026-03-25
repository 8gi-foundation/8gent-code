# temp-dir

Create and manage temporary directories with automatic cleanup.

## Requirements
- createTempDir(prefix?) -> { path: string, cleanup: () => void }
- withTempDir(fn) - auto-cleans after callback
- Uses OS temp directory (os.tmpdir())
- Recursive directory removal on cleanup
- Returns absolute path

## Status

Quarantine - pending review.

## Location

`packages/tools/temp-dir.ts`
