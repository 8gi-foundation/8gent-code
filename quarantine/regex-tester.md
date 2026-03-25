# Quarantine: regex-tester

**Status:** Quarantine - needs review before wiring into agent tools index

**File:** `packages/tools/regex-tester.ts`

---

## What it does

- `testRegex(pattern, input, flags?, preset?)` - runs a regex against input, returns all matches with capture groups and named groups
- `explainRegex(pattern)` - tokenizes a pattern and describes each component in plain English
- `PRESETS` - 8 common patterns: email, url, semver, ipv4, date_iso, hex_color, slug, uuid
- CLI with 4 subcommands: `test`, `preset`, `explain`, `presets`

## Usage

```bash
# Test a custom pattern
bun packages/tools/regex-tester.ts test "(\w+)@(\w+)\.\w+" "hello@example.com" g

# Use a preset
bun packages/tools/regex-tester.ts preset email "contact user@example.com"

# Explain a pattern
bun packages/tools/regex-tester.ts explain "(\d{4})-(\d{2})-(\d{2})"

# List all presets
bun packages/tools/regex-tester.ts presets
```

## API

```ts
import { testRegex, explainRegex, PRESETS } from "./packages/tools/regex-tester.ts";

const result = testRegex("(\\w+)@(\\w+)\\.\\w+", "user@example.com", "g");
// result.matches[0].groups => ["user", "example"]

const exp = explainRegex("^\\d{4}-\\d{2}-\\d{2}$");
// exp.tokens => [{token: "^", description: "Start of string/line"}, ...]

const emailPreset = PRESETS.email;
// emailPreset.pattern, .flags, .description
```

## Integration checklist (before un-quarantining)

- [ ] Wire into `packages/tools/index.ts` tool registry
- [ ] Add to agent tool descriptions in `packages/eight/tools.ts`
- [ ] Add unit tests covering all presets and edge cases (invalid pattern, no matches, named groups)
- [ ] Decide whether `explainRegex` output should be AI-summarized via judge model (see AI Judging Rule in CLAUDE.md)
- [ ] Consider whether pattern explanation belongs in a dedicated `/regex` agent command

## Dependencies

Zero. Pure TypeScript, standard `RegExp` and `String.matchAll`.

## Blast radius

Touches 1 new file only. Safe to keep in quarantine indefinitely.
