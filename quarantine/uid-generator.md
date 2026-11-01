# Quarantine: uid-generator

**Package:** `packages/tools/uid-generator.ts`
**Status:** Quarantine - review before wiring into agent tools

## What It Does

Generates collision-resistant IDs in multiple formats for different use cases within 8gent.

## Exported Functions

| Function | Signature | Output Example |
|----------|-----------|----------------|
| `shortId` | `(len?: number) => string` | `aB3xZ9Kp` |
| `prefixedId` | `(prefix: string, len?: number) => string` | `usr_aB3xZ9Kp` |
| `timestampId` | `(randomSuffixLen?: number) => string` | `01af3c2b9d8e-a3f1bc` |
| `sequentialId` | `(suffixLen?: number) => string` | `000001-aB3x` |
| `randomHex` | `(len?: number) => string` | `a3f1bc09e2d4` |
| `slug` | `(text: string, suffixLen?: number) => string` | `hello-world-a3f1` |
| `hashId` | `(content: string, len?: number) => string` | `2cf24dba5fb0a30e` |

## Design Decisions

- `shortId` and `prefixedId` use base-62 (alphanumeric, case-sensitive) for compact, URL-safe output.
- `timestampId` is lexicographically sortable by creation time - suitable for database keys.
- `sequentialId` is process-scoped and monotonic. Combine with `prefixedId` for distributed uniqueness.
- `slug` always appends a random hex suffix so identical text inputs don't produce the same slug.
- `hashId` is deterministic (SHA-256 truncated) - use for deduplication, not secrecy.
- All random generation uses `crypto.getRandomValues` - no `Math.random()`.

## Use Cases

```ts
import { shortId, prefixedId, timestampId, sequentialId, randomHex, slug, hashId } from "./packages/tools/uid-generator";

// Typed entity IDs
const userId = prefixedId("usr");       // "usr_mN7qLp2R"
const taskId = prefixedId("task", 12); // "task_aB3xZ9KpLm2N"

// Sortable event log entry
const eventId = timestampId();          // "01af3c2b9d8e-a3f1bc"

// URL-safe slugs (with collision protection)
const articleSlug = slug("Hello World!"); // "hello-world-a3f1"

// Content deduplication
const fileHash = hashId(fileContent, 32);

// One-off random tokens
const token = randomHex(32); // 32-char hex token
```

## Quarantine Checklist

- [ ] Unit tests written and passing
- [ ] Integrated into agent tool registry (`packages/eight/tools.ts`)
- [ ] Reviewed for edge cases (empty input, len=0, non-UTF8 content)
- [ ] Sequential counter reset behavior documented for daemon restarts
