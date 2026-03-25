# quarantine: changelog-gen

**Status:** Review pending
**Branch:** `quarantine/changelog-gen`
**File:** `packages/proactive/changelog-gen.ts`

## What it does

Parses `git log` between two refs (tags, commits, or ISO dates), groups commits by
conventional-commit type, and outputs a Keep a Changelog formatted Markdown fragment.
Zero runtime dependencies - uses only Bun's built-in `$` shell tag.

## Exported API

```ts
import { generateChangelog } from "./packages/proactive/changelog-gen.ts";

const md = await generateChangelog();                            // since last tag
const md = await generateChangelog({ since: "v1.0.0" });        // since tag
const md = await generateChangelog({ since: "v0.8.0", until: "v1.0.0" });
```

### ChangelogOptions

| Field   | Type     | Default    | Description                             |
|---------|----------|------------|-----------------------------------------|
| `since` | `string` | latest tag | Git ref, tag, or ISO date (lower bound) |
| `until` | `string` | `"HEAD"`   | Git ref or tag (upper bound)            |

## CLI usage

```bash
bun run packages/proactive/changelog-gen.ts --since v1.0.0
bun run packages/proactive/changelog-gen.ts --from v0.8.0 --to v1.0.0
bun run packages/proactive/changelog-gen.ts --since 2026-03-01
```

## Commit type mapping

| Type              | Section       |
|-------------------|---------------|
| feat              | Added         |
| fix               | Fixed         |
| refactor/perf/style | Changed     |
| docs              | Documentation |
| revert            | Removed       |
| test/chore/ci/build | Other       |
| type! or BREAKING CHANGE | BREAKING CHANGES |

## Review checklist

- [ ] Tested against v0.8.0..v1.0.0 range
- [ ] Tested with empty range - renders _No changes in this range._
- [ ] generateChangelog() export works when imported
- [ ] No external deps (bun $ only)
- [ ] Wire into release workflow
