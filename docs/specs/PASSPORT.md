# 8gent passport, format v1

Status: slice 1 of epic #5086 (skills and plugs). Open spec: any harness may read or write it.

## Problem

A rented assistant starts from zero on a new device or model, and what it learned stays with the vendor. An owned 8gent carries one file the owner issued and holds.

## Constraint

- Local only. Export and import make no network calls.
- One install, zero deps: system `tar` and the archive code in `packages/marketplace/archive.ts`, the same conventions as [APP-ARCHIVE-FORMAT.md](APP-ARCHIVE-FORMAT.md).
- Keys and tokens are excluded by construction. The passport code never reads `packages/secrets` or the keychain, and the CLI does not load keys for `8gent passport`.

## Not doing (v1)

Memory (slice 2), track record and signing (slice 3), sharing, a registry, sync, or any "verified" claim.

## 1. Layout

```
<name>.tar.gz
└── passport/
    ├── manifest.json
    ├── skills/<name>/SKILL.md      (plus any files the skill folder holds)
    └── plugs/<name>/8gent-extension.json  (plus the plug's files)
```

- Entries are sorted by path, every mtime is 2026-01-01T00:00:00Z, owners are numeric, extended attributes and AppleDouble files are left out, and the gzip header time is zero. The same home exports the same bytes (set `SOURCE_DATE_EPOCH` to pin `created`).
- Regular files and folders only. A link, hard link or device entry is refused on import, as is any path that is absolute, holds `..`, or leaves `passport/`.
- `node_modules`, `.git`, `dist` and `.cache` folders are not exported. A file over 5 MB leaves its item out.
- Import never hands the file to system tar. It gunzips in-process with a hard 200 MB output cap (plus header room), parses the 512-byte tar headers itself (size at offset 124, type at 156, checksum checked; pax `path` and `size` and GNU long names honoured), and refuses an archive over 50 MB, any entry over 5 MB, more than 200 MB of content, more than 10,000 entries, a duplicate path, or any type other than a regular file or folder. Owner names in the headers are never read. All of this is checked before the first byte is written.

## 2. manifest.json

```json
{
  "schemaVersion": 1,
  "kind": "8gent-passport",
  "issuer": "self-issued",
  "created": "2026-10-25T19:40:00.000Z",
  "sections": {
    "skills": [
      { "name": "weekly-review", "path": "skills/weekly-review",
        "metadata": { "8gent": { "origin": "owner" } } }
    ],
    "plugs": [
      { "name": "hello-plug", "path": "plugs/hello-plug", "version": "1.0.0",
        "permissions": ["filesystem-read"] }
    ]
  },
  "leftOut": [ { "section": "skills", "name": "deploy", "reason": "looks like a key or token (skills/deploy/SKILL.md)" } ],
  "files": { "skills/weekly-review/SKILL.md": "<sha256 hex>" }
}
```

- `files` lists every file in `passport/` except `manifest.json`, keyed by its path under `passport/`, valued by sha256 hex.
- `name` matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and `path` is exactly `skills/<name>` or `plugs/<name>`.
- `leftOut` holds names and reasons only, never content.

## 3. Mapping to SKILL.md

A passport skill is a plain SKILL.md folder, so any harness that reads SKILL.md folders reads `passport/skills/` as-is:

| SKILL.md | Passport |
| --- | --- |
| Folder `<name>/` with `SKILL.md` | `passport/skills/<name>/`, copied byte for byte |
| Frontmatter `name`, `description`, `license`, `allowed-tools`, `metadata` | Untouched. The passport never rewrites SKILL.md. |
| Extra files (scripts, references, assets) | Copied with the folder, each one hashed in `files` |
| Harness-specific data | Only under the manifest entry's `metadata`, namespaced `"8gent"`. A reader may ignore it. |

`metadata["8gent"].origin` records where the skill came from so import puts it back where 8gent loads it:

| origin | Exported from | Imported to |
| --- | --- | --- |
| `owner` | `~/.8gent/skills/<name>.md` (as `SKILL.md` in a folder) | `~/.8gent/skills/<name>.md` |
| `learned` | `~/.8gent/learned-skills/<name>.md` | `~/.8gent/learned-skills/<name>.md` |
| `imported` (+ `tool`) | `~/.8gent/imported/<tool>/skills/<name>/` | the same folder when this device has brought its tools home; otherwise `~/.8gent/skills/<name>.md` when the folder holds only `SKILL.md`, else skipped with the reason |

A skill with no `metadata` (written by another harness) is treated as `owner`.

## 4. Secrets

An item (a whole skill or plug) is left out when any of its files:

- has a name that may hold a key: `.env`, `*.env`, `auth*`, `*credential*`, `*token*`, `*secret*`, `*keychain*`, `*.pem`, `*.key`, `*.p12`, `*.pfx` (never opened), or
- matches a credential shape in `packages/permissions/secret-detector.ts`.

Import runs the same shape check and refuses the whole passport on a match.

## 5. Import

1. Size caps and header checks in memory (section 1), then write the checked entries to a temp folder.
2. Verify: every regular file on disk (no folder is skipped on import) equals the `files` set exactly, and every sha256 matches. Any mismatch refuses with exit code 4 and writes nothing.
3. Dry run: one line per item, then `Dry run: N new, M skipped. Apply? [y/N]` through the shared one-yes resolver. Only a typed y or yes applies. No terminal (or CI, `EIGHT_UNATTENDED`, `EIGHT_HEADLESS`) exits 2 and writes nothing.
4. Skills merge: an existing skill is never overwritten (skipped and reported), and every write uses exclusive create.
5. Plugs: only the listed, verified files are copied into a fresh folder, and that folder goes to the quarantine lane as a local source (`packages/quarantine`, `~/.8gent/quarantine/`) and are scanned there. The plug loader reads only `~/.8gent/extensions/`, so a quarantined plug has no capability at all until the owner promotes it by moving it there, where the existing extension scope applies.

Exit codes: 0 done (or declined), 1 usage or I/O, 2 nobody at a terminal, 4 refused (integrity, layout or secret).

## 6. Card

`8gent passport show [file] [--plain]` reads the newest passport export made (or `file`), verifies it, and prints at most 40 columns: "self-issued", the date, counts from the manifest, "Memory: not included", "Track record: not included", "Keys and tokens: never included", the left-out count and the hash status. Every status is a word. `--plain` and non-terminal output have no borders.

## 7. Delete

`8gent passport delete` removes each file listed in `~/.8gent/passport/issued.json` whose sha256 still matches, then the record, and lists what it removed.
