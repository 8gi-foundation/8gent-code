# object-hash

## Description

Deterministic hash of JavaScript objects with sorted keys. Produces stable, reproducible hashes across object construction order, JS engine versions, and runtime environments. Handles special types (Date, Set, Map, RegExp, Buffer) and circular references without throwing.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `objectHash` | `(obj: unknown, options?: HashOptions) => Promise<string>` | Deterministic hash of any value |
| `hashEqual` | `(a: unknown, b: unknown, options?: HashOptions) => Promise<boolean>` | Compare two values by hash |
| `hashStable` | `(obj: unknown, options?: Omit<HashOptions, "sortKeys">) => Promise<string>` | Hash ignoring key insertion order |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `algorithm` | `"sha256"` | Hash algorithm: `sha256`, `sha1`, `md5` |
| `encoding` | `"hex"` | Output encoding: `hex`, `base64` |
| `sortKeys` | `true` | Sort object keys before hashing |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/memory/` to detect duplicate or near-duplicate memory entries before insertion.
3. Use in `packages/validation/` checkpoint logic to verify object state hasn't drifted between saves.
4. Use in `packages/self-autonomy/` to fingerprint reflection snapshots and skip redundant processing.
5. Expose as an agent tool so Eight can compare structured data (config objects, API responses) for equality without serialisation drift.

## Source

`packages/tools/object-hash.ts` - 133 lines, zero production dependencies, Web Crypto + Node.js fallback.
