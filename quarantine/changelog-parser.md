# Quarantine: Changelog Parser

## What

`packages/tools/changelog-parser.ts` - a parser for CHANGELOG.md files that follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Extracts versions, dates, and changes grouped by category into structured JSON.

## Why

Downstream tools (release automation, Telegram notifications, dashboard displays) need structured access to changelog data. Parsing markdown every time is fragile and repetitive. A single canonical parser keeps it consistent.

## API

```ts
import { parseChangelog, parseChangelogFile } from "./packages/tools/changelog-parser";

// From string
const result = parseChangelog(markdownString);

// From file (Bun)
const result = await parseChangelogFile("./CHANGELOG.md");
```

### Output Shape

```ts
interface ParsedChangelog {
  title: string | null;
  description: string | null;
  entries: ChangelogEntry[];
}

interface ChangelogEntry {
  version: string;
  date: string | null;
  yanked: boolean;
  categories: Record<string, string[]>;
}
```

### Example Output

```json
{
  "title": "Changelog",
  "description": "All notable changes to this project.",
  "entries": [
    {
      "version": "1.0.0",
      "date": "2026-03-22",
      "yanked": false,
      "categories": {
        "Added": ["Feature A", "Feature B"],
        "Fixed": ["Bug fix C"]
      }
    }
  ]
}
```

## Exit Criteria

- [ ] Wire into release automation or Telegram bot notification flow
- [ ] Add unit tests
- [ ] Confirm edge cases: empty changelog, missing dates, `[YANKED]` entries, sub-headings (h4) within categories

## Size

~80 lines. Zero dependencies beyond Bun runtime.
