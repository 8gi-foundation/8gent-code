# App Archive Format and Submission Protocol

> Issue #2089 - Define the marketplace submission format for 8gent apps

## Problem

The 8gent marketplace needs a deterministic, verifiable format for distributing apps (skills, extensions, agent bundles) between authors, the registry, and end-user installs. Without it, every install path becomes ad-hoc, integrity cannot be checked, and the control plane has no contract to enforce against.

## Constraint

- No new native deps. Use system `tar` for packaging (already used by `packages/runtime/installer.ts`).
- Validation lives in `packages/marketplace/` and is callable from CLI, registry, and the control plane without forking logic.
- Archive must be reproducible from the same source tree (sorted entries, normalized timestamps).

## Not doing

- Server-side approval workflow (control plane).
- Automated security scanning of app code (separate effort).
- Signature/PGP signing (deferred to a follow-up; integrity file is the seed for it).
- Versioned archive format negotiation (v1 only for now).

## Success metric

- `8gent publish <app-dir>` produces a `.8gent-app.tar.gz` that round-trips through extract + verify with no errors.
- A malformed manifest is rejected by the same Zod schema in CLI, registry, and control plane.
- Size, capability, and lint gates fail loudly before an upload is attempted.

---

## 1. Archive Layout

```
<name>-<version>.8gent-app.tar.gz
└── <name>-<version>/
    ├── manifest.json          # required, top-level
    ├── INTEGRITY.json         # required, SHA-256 per file
    ├── SKILL.md               # required (skill copy or app card)
    ├── README.md              # optional
    ├── LICENSE                # optional but strongly recommended
    └── src/                   # required, app source
        └── ...
```

Rules:

- Root directory inside the tarball MUST be `<name>-<version>/`. Nothing escapes it.
- All entries are regular files or directories. No symlinks, no hardlinks, no devices, no setuid bits.
- Tar entries are stored sorted by path (lexicographic). This is what makes the archive reproducible.
- Filename convention: `<name>-<version>.8gent-app.tar.gz`. Both `name` and `version` are taken verbatim from the manifest.

## 2. Manifest (`manifest.json`)

Required fields:

| Field | Type | Notes |
|------|------|------|
| `name` | string | `[a-z0-9][a-z0-9-]*`, 1-64 chars |
| `version` | string | SemVer (`x.y.z` or `x.y.z-pre`) |
| `author` | string | Display name. 1-128 chars |
| `description` | string | 1-280 chars |
| `license` | string | SPDX identifier (e.g. `Apache-2.0`, `MIT`) or `UNLICENSED` |
| `entry` | string | Relative path inside `src/` to the entry module |
| `capabilities` | string[] | Capability tier names the app needs to run |
| `manifestVersion` | number | Always `1` for this spec |

Optional fields:

| Field | Type | Notes |
|------|------|------|
| `homepage` | string | URL |
| `repository` | string | URL |
| `keywords` | string[] | Up to 16 lowercase tokens |
| `engines` | `{ "8gent": string }` | SemVer range, e.g. `>=0.12.0` |
| `tools` | object[] | Tool names declared by the app |

### Capabilities

Apps must declare every capability tier they use. The pre-submission audit rejects archives that declare `dangerous` without an out-of-band review marker. Recognized tiers (defined in `packages/marketplace/manifest.ts`):

- `read` - read-only filesystem and env access
- `write` - filesystem writes inside the app sandbox
- `network` - outbound HTTP
- `process` - shell out to other commands
- `dangerous` - reserved for power tools (raw subprocess, unrestricted writes). Requires manual review.

## 3. Integrity File (`INTEGRITY.json`)

```json
{
  "algorithm": "sha256",
  "files": {
    "manifest.json": "<hex>",
    "SKILL.md": "<hex>",
    "src/index.ts": "<hex>"
  },
  "rootHash": "<hex>"
}
```

- `files` lists every file in the archive **except** `INTEGRITY.json` itself, keyed by archive-relative path.
- `rootHash` is `sha256(JSON.stringify(sortedFiles))` where `sortedFiles` is the entries of `files` sorted by key, serialized as a canonical JSON array of `[path, hash]` pairs. This gives a single value to sign or pin.
- Verifiers MUST recompute every per-file hash and the `rootHash`. Any mismatch is a hard fail.

## 4. Submission Protocol

```
8gent publish <app-dir> [--out <path>] [--max-size <mb>] [--allow-dangerous]
```

Steps the CLI runs, in order:

1. **Load + validate manifest** with the Zod schema (`manifestSchema.parse`).
2. **Lint** - run `biome check` on `src/` if biome is available; emit warnings, not failures, unless `--strict`.
3. **Capability audit** - reject if `capabilities` includes `dangerous` and `--allow-dangerous` is not set.
4. **Collect files** - walk `app-dir`, skip `node_modules`, `.git`, `dist`, dotfiles outside the allowed list (`.env.example`, `.gitignore` are kept; everything else under `.` is dropped).
5. **Hash + write `INTEGRITY.json`** into a temp staging dir.
6. **Tar + gzip** the staging dir into `<name>-<version>.8gent-app.tar.gz`.
7. **Size check** - reject if final archive exceeds the limit (default 10 MiB, configurable via `--max-size`).
8. **Round-trip verify** - extract into a temp dir and re-verify integrity before declaring success.

Exit codes:

- `0` - archive built and verified
- `1` - manifest validation failure
- `2` - capability audit failure
- `3` - size limit exceeded
- `4` - integrity verification failed
- `5` - I/O or tar error

## 5. URL Allowlist

`isAllowedArchiveUrl(url: string): boolean` is the single decision point for whether an archive URL can be installed by the runtime. The function lives in `packages/marketplace/url-allowlist.ts` and is used by both the CLI installer and the control plane.

Defaults (all over HTTPS):

- `github.com/8gi-foundation/*` and `objects.githubusercontent.com/*` - 8GI Foundation source repos and GitHub release artifacts.
- `raw.githubusercontent.com/8gi-foundation/*`
- `cdn.8gent.dev/*` - foundation-managed CDN.
- `*.fly.dev` is **not** in the default allowlist; vessel hosts are dynamic and should not be a default trust root.

Operators can extend the allowlist via `EIGHT_ARCHIVE_ALLOWLIST` (comma-separated host patterns). Patterns support a leading `*.` wildcard for subdomain matches, but cannot use full glob syntax.

The function MUST reject:

- Non-HTTPS URLs (except `http://localhost` for local dev).
- URLs with credentials (`https://user:pass@host`).
- Host patterns not in the allowlist.

## 6. Verification on Install

Install flow (consumer side):

1. Resolve URL through `isAllowedArchiveUrl`.
2. Download to a temp file. Cap downloads at the same configured size limit as `publish`.
3. `tar -tzf` to enumerate entries before extraction. Reject if any entry path contains `..` or starts with `/`.
4. Extract into a per-app sandbox directory.
5. Read `INTEGRITY.json`, recompute every hash, recompute `rootHash`.
6. Re-validate `manifest.json` against the same Zod schema.

Any failure aborts install and removes the staging directory.

## 7. Test Expectations

`packages/marketplace/` ships unit tests covering:

- Manifest schema accepts a minimal valid record and rejects each required field individually.
- `isAllowedArchiveUrl` accepts the GitHub + foundation defaults and rejects credentials, non-HTTPS, and non-allowlisted hosts.
- Round-trip: build a fixture app, publish it, extract it, re-verify integrity. Output should be byte-identical between two runs (reproducibility).
- Capability audit blocks `dangerous` without the override flag.
- Size limit triggers exit code `3` when crossed.
