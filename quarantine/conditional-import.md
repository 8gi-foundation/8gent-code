# conditional-import

**Tool name:** conditional-import
**File:** `packages/tools/conditional-import.ts`
**Status:** quarantine

## Description

Safe conditional module importer. Graceful degradation when optional packages are absent.

| Export | Purpose | Notes |
|--------|---------|-------|
| `tryImport<T>(specifier)` | Import or return null | Default export preferred; full module fallback. |
| `requireOptional<T>(specifier, fallback)` | Import or return fallback | Caller never needs to null-check. |
| `isAvailable(specifier)` | Availability check | No side effects; result cached. |
| `importWithTimeout<T>(specifier, ms)` | Import with deadline | Default 5000ms; null on timeout. |
| `clearImportCache()` | Reset cache | For tests or runtime installs. |

## Integration Path

1. `packages/tools/image.ts` - optionally load `sharp` without making it a hard dep
2. `packages/daemon/` - probe `node:worker_threads` vs `bun:jsc` at runtime
3. Future plugin loader - surface capability flags without crashing on missing packages
4. `packages/self-autonomy/` - check optional analysis library availability before use

## Dependencies

None. Pure TypeScript, zero runtime dependencies.
