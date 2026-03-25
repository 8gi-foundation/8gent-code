# file-hasher

**Status:** Quarantine - not wired into index

**Package:** `packages/tools/file-hasher.ts`

## What it does

Streaming file and directory hashing utility. Uses Node.js `crypto` streams so
large files are never loaded into memory.

## Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `hashFile` | `(path, algo?) => Promise<string>` | Stream-hash a single file |
| `hashDirectory` | `(dir, options?) => Promise<DirectoryHashResult>` | Hash all files in a tree, returns per-file map + combined hash |
| `compareHashes` | `(pathA, pathB, algo?) => Promise<boolean>` | Content-equality check for two files or directories |
| `verifyHash` | `(path, expected, algo?) => Promise<boolean>` | Verify a file against a known hash string |

## Options

```ts
interface DirectoryHashOptions {
  algorithm?: "md5" | "sha1" | "sha256" | "sha512"; // default: sha256
  ignore?: string[];   // directory/file names to skip
  recursive?: boolean; // default: true
}
```

## Usage

```ts
import { hashFile, hashDirectory, compareHashes, verifyHash } from "./packages/tools/file-hasher";

// Hash a single large file without OOM risk
const digest = await hashFile("/path/to/big.iso");

// Hash an entire directory tree, skip node_modules and .git
const { combined, files } = await hashDirectory("./src", {
  ignore: ["node_modules", ".git"],
});

// Compare two directories for identical content
const same = await compareHashes("./dist-a", "./dist-b");

// Verify a downloaded file against a published SHA256
const ok = await verifyHash("./archive.tar.gz", "abc123...");
```

## Why quarantine

No immediate consumer in the codebase. Candidate for use in:
- `packages/validation/` integrity checks before revert
- Artifact verification in `scripts/`
- Content-addressed caching in memory or orchestration layers
