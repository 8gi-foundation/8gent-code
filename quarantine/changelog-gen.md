# quarantine: changelog-gen

**Status:** Review pending
**Branch:** `quarantine/changelog-gen`
**File:** `packages/proactive/changelog-gen.ts`

---

## What it does

Parses `git log` between two refs (tags, commits, or ISO dates), groups commits by
conventional-commit type, and outputs a [Keep a Changelog](https://keepachangelog.com/)
formatted Markdown fragment.

Zero runtime dependencies - uses only Bun's built-in `$` shell tag.

---

## Exported API

```ts
import { generateChangelog } from "./packages/proactive/changelog-gen.ts";

// Since last tag -> HEAD
const md = await generateChangelog();

// Since a specific tag
const md = await generateChangelog({ since: "v1.0.0" });

// Between two tags
const md = await generateChangelog({ since: "v0.8.0", until: "v1.0.0" });
```

### `ChangelogOptions`

| Field   | Type     | Default      | Description                             |
|---------|----------|--------------|-----------------------------------------|
| `since` | `string` | latest tag   | Git ref, tag, or ISO date (lower bound) |
| `until` | `string` | `"HEAD"`     | Git ref or tag (upper bound)            |

---

## CLI usage

```bash
# Since last tag
bun run packages/proactive/changelog-gen.ts

# Since a tag
bun run packages/proactive/changelog-gen.ts --since v1.0.0

# Between two tags (--from/--to aliases work too)
bun run packages/proactive/changelog-gen.ts --from v0.8.0 --to v1.0.0

# Since a date
bun run packages/proactive/changelog-gen.ts --since 2026-03-01
```

Output goes to stdout. Errors go to stderr.

---

## Output format

```markdown
## [Unreleased] - 2026-03-25

_Changes from `v1.0.0` to `HEAD`_

### Added

- add worktree delegation benchmark [`742ac14`](https://github.com/PodJamz/8gent-code/commit/742ac14)

### Fixed

- fix auth race on session resume [`a1b2c3d`](https://github.com/PodJamz/8gent-code/commit/a1b2c3d)
```

---

## Commit type mapping

| Conventional type                        | Changelog section |
|------------------------------------------|-------------------|
| `feat`                                   | Added             |
| `fix`                                    | Fixed             |
| `refactor`, `perf`, `style`              | Changed           |
| `docs`                                   | Documentation     |
| `revert`                                 | Removed           |
| `test`, `chore`, `ci`, `build`           | Other             |
| `<type>!:` or `BREAKING CHANGE` in body | BREAKING CHANGES (also appears in its typed section) |

---

## Review checklist

- [ ] Tested against `v0.8.0..v1.0.0` range - output matches expected sections
- [ ] Tested with no commits in range - renders `_No changes in this range._`
- [ ] Tested `--from` / `--to` aliases
- [ ] `generateChangelog()` export works when imported in another module
- [ ] No external deps introduced (`bun $` only)
- [ ] Merge into main and wire into release workflow
