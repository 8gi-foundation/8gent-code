# Quarantine: semver

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/semver.ts`

---

## What it does

Zero-dependency semver 2.0.0 parser, comparator, range matcher, sorter, and bumper.

| Function | Signature | Description |
|----------|-----------|-------------|
| `parse` | `(version: string) => SemVer \| null` | Parse a version string. Returns null if invalid. |
| `parseStrict` | `(version: string) => SemVer` | Parse, throws on invalid. |
| `valid` | `(version: string) => boolean` | Returns true if the string is valid semver. |
| `stringify` | `(v: SemVer) => string` | Canonical string from a SemVer object. |
| `compare` | `(a, b) => -1 \| 0 \| 1` | Compare two versions. Build metadata ignored per spec. |
| `gt` | `(a, b) => boolean` | a > b |
| `gte` | `(a, b) => boolean` | a >= b |
| `lt` | `(a, b) => boolean` | a < b |
| `lte` | `(a, b) => boolean` | a <= b |
| `eq` | `(a, b) => boolean` | a === b |
| `neq` | `(a, b) => boolean` | a !== b |
| `satisfies` | `(version, range) => boolean` | Does version satisfy the range string? |
| `filter` | `(versions, range) => string[]` | Filter versions array by range. |
| `sortAsc` | `(versions) => string[]` | Sort ascending (lowest first). |
| `sortDesc` | `(versions) => string[]` | Sort descending (highest first). |
| `maxVersion` | `(versions) => string \| null` | Highest valid version in array. |
| `minVersion` | `(versions) => string \| null` | Lowest valid version in array. |
| `bump` | `(version, type, identifier?) => string` | Increment a version. |
| `diff` | `(a, b) => ReleaseType \| "none"` | What kind of change separates two versions. |

`SemVer` shape:
```ts
{
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  buildmetadata: string[];
  raw: string;
}
```

---

## Range syntax supported

| Syntax | Example | Meaning |
|--------|---------|---------|
| Exact | `1.2.3` | Exactly 1.2.3 |
| Wildcard | `1.2.x`, `1.x`, `*` | All patch/minor/all versions |
| Comparison | `>=1.0.0`, `<2.0.0`, `!=1.5.0` | Standard operators |
| Tilde | `~1.2.3` | >=1.2.3 <1.3.0 |
| Caret | `^1.2.3` | >=1.2.3 <2.0.0 |
| Hyphen | `1.0.0 - 2.0.0` | Inclusive range |
| AND | `>=1.0.0 <2.0.0` | Space-separated conditions |
| OR | `^1.0 \|\| ^2.0` | Either range set |

---

## CLI usage

```bash
bun packages/tools/semver.ts parse 1.2.3-alpha.1
bun packages/tools/semver.ts valid 1.2.3
bun packages/tools/semver.ts compare 1.2.3 1.3.0     # => -1
bun packages/tools/semver.ts gt 2.0.0 1.9.9           # => true
bun packages/tools/semver.ts satisfies 1.2.3 "^1.0.0" # => true
bun packages/tools/semver.ts bump 1.2.3 minor          # => 1.3.0
bun packages/tools/semver.ts bump 1.2.3 premajor beta  # => 2.0.0-beta.0
bun packages/tools/semver.ts diff 1.0.0 2.0.0          # => major
bun packages/tools/semver.ts sort 1.3.0 1.0.0 2.0.0-alpha.1 2.0.0
bun packages/tools/semver.ts max 1.0.0 2.0.0 1.5.0    # => 2.0.0
bun packages/tools/semver.ts min 1.0.0 2.0.0 1.5.0    # => 1.0.0
```

---

## Implementation notes

- No external dependencies. Pure TypeScript string/number operations.
- `SEMVER_RE` is the canonical regex from semver.org.
- Prerelease comparison follows spec: numeric identifiers compared numerically, alphanumeric lexically, numeric < alphanumeric.
- Build metadata is parsed and stored but ignored for all comparisons per spec.
- Leading `v` prefix stripped silently on parse (`v1.2.3` => `1.2.3`).
- `bump("prerelease")` increments the last numeric identifier in the prerelease array, or appends `0` if none found.
- Invalid versions in sort/filter/max/min are treated leniently rather than throwing.

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry. Export the functions and register when needed.

Potential uses:
- `packages/self-autonomy/meta-versioning.ts` - version comparison for evolution checkpoints
- Model version comparisons in `packages/eight/agent.ts`
- Release automation in `scripts/`
- Package update checks in the dependency graph tool
