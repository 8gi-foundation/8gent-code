# version-comparator

**Status:** quarantine

## Description

Self-contained semantic version comparison and range checking tool. Parses semver strings
(with optional pre-release and build metadata), compares and sorts them, checks version
satisfaction against common range operators, and bumps versions by release type.

## Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `compareVersions` | `(a: string, b: string) => -1 \| 0 \| 1` | Compare two semver strings |
| `sortVersions` | `(versions: string[]) => string[]` | Sort ascending (lowest first) |
| `satisfies` | `(version: string, range: string) => boolean` | Check range satisfaction |
| `bumpVersion` | `(version: string, type: BumpType, preReleaseId?) => string` | Bump by type |

## Range Operators Supported

`^`, `~`, `>=`, `<=`, `>`, `<`, `=`, bare version (exact match), and space-separated AND conditions (e.g. `>=1.0.0 <2.0.0`).

## Pre-release Ordering

Follows semver spec: numeric identifiers sort numerically, alphanumeric sort lexically,
and a release version is always greater than its pre-release counterpart (`1.0.0 > 1.0.0-rc.1`).

## Integration Path

1. Wire into `packages/tools/` barrel export (`index.ts` or `tools.ts`).
2. Expose as a tool in `packages/eight/tools.ts` for agent use - useful when Eight needs to
   reason about package versions in `package.json` or `lockfiles`.
3. Optionally expose via the CLI as `8gent version compare <a> <b>`.

## File

`packages/tools/version-comparator.ts` - 150 lines, zero dependencies.
