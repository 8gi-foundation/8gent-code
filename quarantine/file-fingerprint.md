# file-fingerprint

**Status:** quarantine

## Description

Generates stable fingerprints for files based on content and optional metadata (mtime, size). Supports single-file fingerprinting, change detection, and batch directory scanning with diff output.

## Integration path

`packages/tools/file-fingerprint.ts` - ready for wiring into `packages/eight/tools.ts` as a built-in agent tool.

Candidate use cases:
- Cache invalidation - detect when source files change between agent sessions
- Checkpoint validation - verify files haven't drifted since a snapshot was taken
- Incremental builds - skip re-processing unchanged files in batch workflows

## Exports

| Symbol | Signature | Notes |
|--------|-----------|-------|
| `fingerprint` | `(path, options?) => Fingerprint` | Single file, content + size by default |
| `hasChanged` | `(path, previousFP, options?) => boolean` | Returns true if changed or unreadable |
| `fingerprintsMatch` | `(a, b) => boolean` | Direct fingerprint comparison |
| `fingerprintDirectory` | `(dirPath, options?) => BatchResult` | Recursive directory scan |
| `diffBatch` | `(previous, current) => {added, removed, changed}` | Diff two BatchResults |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `algorithm` | `"sha256"` | Hash algorithm: sha256, sha1, md5 |
| `includeSize` | `true` | Include file size in hash |
| `includeMtime` | `false` | Include mtime (false = content-stable across copies) |

## Integration checklist

- [ ] Add tool definition in `packages/eight/tools.ts`
- [ ] Add permission entry in `packages/permissions/` (read-only, no write access needed)
- [ ] Wire into agent system prompt capabilities list
