# Quarantine: hash

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/hash.ts`

---

## What it does

Cryptographic hash utilities backed by Bun's built-in `crypto` module. Zero external dependencies.

| Function | Signature | Description |
|----------|-----------|-------------|
| `sha256` | `(data, encoding?) => string` | SHA-256 digest of a string or Buffer. |
| `sha512` | `(data, encoding?) => string` | SHA-512 digest of a string or Buffer. |
| `md5` | `(data, encoding?) => string` | MD5 digest - checksums only, not cryptographically secure. |
| `hash` | `(data, algorithm?, encoding?) => HashResult` | Generic hash primitive. Returns full `HashResult` object. |
| `hashFile` | `(path, algorithm?, encoding?) => Promise<FileHashResult>` | Hash a file. Reads entire file into memory. |
| `hashFiles` | `(paths, algorithm?, encoding?) => Promise<Map<string, FileHashResult>>` | Hash multiple files in parallel. |
| `contentId` | `(data, algorithm?) => string` | Content-addressable ID in `algorithm:digest` format. Accepts string, Buffer, or plain object (JSON-serialised). |
| `parseContentId` | `(id) => {algorithm, digest} \| null` | Parse a content ID string into its components. |
| `verifyContentId` | `(data, id) => boolean` | Verify data matches a content ID. |
| `hmac` | `(data, secret, algorithm?, encoding?) => HmacResult` | HMAC with configurable algorithm. |
| `verifyHmac` | `(data, secret, expected, algorithm?, encoding?) => boolean` | Constant-time HMAC verification (uses `timingSafeEqual`). |
| `createHashRing` | `(replicationFactor?) => ConsistentHashRing<T>` | Consistent hash ring with virtual nodes. Default 150 replicas per node. |

`HashResult` shape:
```ts
{
  algorithm: "sha256" | "sha512" | "md5";
  digest: string;
  encoding: "hex" | "base64" | "base64url";
  byteLength: number;
}
```

`FileHashResult` extends `HashResult` with:
```ts
{
  path: string;
  sizeBytes: number;
}
```

`ConsistentHashRing<T>` interface:
```ts
{
  add(node: T): void;
  remove(node: T): void;
  get(key: string): T | null;
  nodes(): T[];
}
```

---

## CLI usage

```bash
# SHA-256 of text
bun packages/tools/hash.ts sha256 "hello world"

# SHA-512 of text
bun packages/tools/hash.ts sha512 "hello world"

# MD5 of text (checksum only)
bun packages/tools/hash.ts md5 "hello world"

# Hash a file (default sha256)
bun packages/tools/hash.ts file ./package.json

# Hash a file with sha512
bun packages/tools/hash.ts file ./package.json sha512

# Content-addressable ID
bun packages/tools/hash.ts cid "some content"

# HMAC-SHA256
bun packages/tools/hash.ts hmac mysecret "data to sign"
```

---

## Implementation notes

- All hashing uses Node/Bun's built-in `crypto` module - no npm deps.
- `verifyHmac` uses `timingSafeEqual` to prevent timing side-channels.
- `contentId` JSON-serialises plain objects before hashing - field order matters. Normalise before calling if key order may vary.
- Consistent hash ring uses SHA-256 internally for point placement. Virtual nodes default to 150 per real node for even distribution across small clusters.
- `hashFile` loads the full file into memory. For very large files (multi-GB), a streaming variant should be added before production use.

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry. Export the functions and register them when needed.

Potential uses:
- Content-addressable memory store keys (replace arbitrary UUIDs with deterministic IDs)
- File integrity verification in the validation/healing loop
- Cache key generation in browser tool and design-systems DB
- HMAC request signing for daemon WebSocket auth
- Consistent routing of agent tasks to worktree nodes in `packages/orchestration/`
