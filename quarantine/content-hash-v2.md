# content-hash-v2

## Tool Name
`content-hash-v2`

## Description
Content-addressable hashing for build caching and incremental pipeline support. Hashes arbitrary content, individual files, and full directory trees. Generates path-to-hash manifests and diffs them to identify changed, added, and removed files between builds. No external dependencies - built on Node.js `crypto` and `fs`.

## Exported API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `contentHash` | `(content: string \| Buffer, algo?: HashAlgo) => string` | Hash arbitrary content |
| `fileContentHash` | `(filePath: string, algo?: HashAlgo) => string` | Hash a single file by path |
| `directoryHash` | `(dir: string, ignore?: string[], algo?: HashAlgo) => string` | Hash a full directory tree into a single digest |
| `hashManifest` | `(dir: string, ignore?: string[], algo?: HashAlgo) => HashManifest` | Build a `{ relativePath: hash }` map for a directory |
| `diffManifests` | `(prev: HashManifest, next: HashManifest) => ManifestDiff` | Diff two manifests - returns `{ changed, added, removed }` |

## Types

```ts
type HashAlgo = "sha256" | "sha1" | "md5";
type HashManifest = Record<string, string>;

interface ManifestDiff {
  changed: string[];
  added: string[];
  removed: string[];
}
```

## Status
**quarantine** - isolated, not wired into the agent tool registry yet.

## Integration Path

1. Review API surface - confirm `hashManifest` + `diffManifests` is sufficient for the build cache use case.
2. Wire into the build pipeline or agent tool registry as a caching layer.
3. Add to `packages/eight/tools.ts` if the agent should be able to detect which files changed between runs.
4. Add a test in `benchmarks/categories/abilities/` to verify manifest diffing correctness.
5. Consider persisting manifests to `.8gent/cache/manifests/` for cross-session incremental builds.
6. Graduate from quarantine - remove this file and update tool inventory.

## Notes
- Default algo is `sha256`. Use `md5` for speed if collision resistance is not required.
- Default ignore list covers `.git`, `node_modules`, `.8gent`, `dist`, `.cache`, `*.log`.
- `directoryHash` is deterministic: files are sorted by path before hashing.
- `diffManifests` operates on plain objects - manifests can be serialized to JSON and stored between builds.
