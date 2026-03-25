# content-hasher

**Tool name:** content-hasher
**Package path:** `packages/tools/content-hasher.ts`
**Status:** quarantine

## Description

Content-addressable hashing utility for deduplication and caching. Provides SHA256/MD5/SHA1/SHA512 hashing of strings and Buffers, streaming file hashing for large files, and Merkle-style directory hash trees for fast change detection.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `contentHash` | `(data, algo?, encoding?) => HashResult` | Hash a string or Buffer |
| `storageKey` | `(data, algo?) => string` | Generate `algo:hex` CAS key |
| `hashFile` | `(path, algo?) => Promise<HashResult>` | Stream-hash a file |
| `hashDir` | `(path, algo?) => Promise<DirHashTree>` | Build directory hash tree |
| `flattenHashTree` | `(tree) => Record<string, string>` | Flatten tree to path->hash map |
| `diffHashTrees` | `(before, after) => { added, removed, changed }` | Diff two snapshots |

## Integration path

1. **Caching layer** - use `storageKey()` to key agent response caches. Identical prompts get the same key, enabling exact-match cache hits.
2. **Deduplication** - before storing tool output or memory fragments, `contentHash()` the payload. Skip write if hash already exists.
3. **Change detection** - wire `hashDir()` into the workspace scanner to detect file changes between sessions without reading every file.
4. **Memory dedup** - integrate into `packages/memory/store.ts` to prevent duplicate episodic memory entries.
5. **Artifact verification** - use `hashFile()` in the validation package to verify downloaded or generated files against expected hashes.

## Usage example

```typescript
import { contentHash, hashFile, hashDir, storageKey } from "./packages/tools/content-hasher";

const { hash } = contentHash("hello world");           // sha256 hex
const key = storageKey(responsePayload);               // "sha256:abc123..."
const result = await hashFile("/path/to/file.ts");     // streaming
const tree = await hashDir("/path/to/src");            // hash tree
```

## Constraints

- No external dependencies - uses Node.js built-in `crypto` module only.
- Streaming hash avoids memory pressure on large files.
- `hashDir` is recursive - avoid on deeply nested trees with thousands of files without concurrency limits.
