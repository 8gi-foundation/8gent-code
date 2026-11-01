# Quarantine: path-utils

**Status:** Quarantine - pending integration review
**Package:** `packages/tools/path-utils.ts`
**Branch:** `quarantine/path-utils`

## What It Is

Cross-platform path manipulation utilities. Pure functions with no filesystem access and no Node/Bun dependencies. Works on both POSIX and Windows-style paths.

## Exported API

| Function | Signature | Description |
|----------|-----------|-------------|
| `ensureTrailingSlash` | `(path: string) => string` | Ensures path ends with `/` |
| `removeTrailingSlash` | `(path: string) => string` | Strips trailing `/`, preserves root `/` |
| `normalizeSlashes` | `(path: string) => string` | Converts `\` to `/`, collapses duplicates |
| `isAbsolute` | `(path: string) => boolean` | True if path starts with `/` or Windows drive |
| `isRelative` | `(path: string) => boolean` | Inverse of `isAbsolute` |
| `relativeTo` | `(from: string, to: string) => string` | Computes relative path between two directories |
| `commonPrefix` | `(paths: string[]) => string` | Longest shared path prefix across all inputs |
| `withExtension` | `(path: string, ext: string) => string` | Replaces or adds file extension |
| `withoutExtension` | `(path: string) => string` | Strips file extension |
| `splitPath` | `(path: string) => string[]` | Splits path into segments, filters empty strings |

## Example Usage

```ts
import {
  ensureTrailingSlash,
  removeTrailingSlash,
  normalizeSlashes,
  relativeTo,
  isAbsolute,
  isRelative,
  commonPrefix,
  withExtension,
  withoutExtension,
  splitPath,
} from "@8gent/tools/path-utils";

ensureTrailingSlash("/foo/bar")         // => "/foo/bar/"
removeTrailingSlash("/foo/bar/")        // => "/foo/bar"
normalizeSlashes("C:\\Users\\james")    // => "C:/Users/james"
isAbsolute("/etc/hosts")                // => true
isRelative("./src/index.ts")            // => true
relativeTo("/a/b/c", "/a/b/d/e")       // => "../d/e"
commonPrefix(["/a/b/c", "/a/b/d"])     // => "/a/b"
withExtension("src/foo.js", ".ts")     // => "src/foo.ts"
withoutExtension("src/index.ts")       // => "src/index"
splitPath("/a/b/c")                    // => ["a", "b", "c"]
```

## Why Quarantine

This utility is self-contained and low-risk. Quarantine is standard process for new utility packages before wiring into the broader agent toolchain.

## Integration Candidates

- `packages/eight/tools.ts` - agent file operations can use `normalizeSlashes` and `relativeTo`
- `packages/orchestration/` - worktree path resolution
- `packages/ast-index/` - import graph path normalization
- Any package that currently does ad-hoc string slicing for paths

## Constraints

- No filesystem access - all pure string manipulation
- No dependencies outside this file
- Handles edge cases: root `/`, Windows drives, empty strings, extension-less files
