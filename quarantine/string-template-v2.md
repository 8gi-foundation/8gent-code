# Quarantine: string-template-v2

**Status:** Quarantine - awaiting integration review
**Package:** `packages/tools/string-template-v2.ts`
**Branch:** `quarantine/string-template-v2`

---

## What it does

Template string rendering with pipe-filter syntax. Resolves `{key|filter1|filter2}` expressions against a data map and applies a chain of named transforms to the resolved value.

---

## API

```ts
import { template, registerFilter } from "./packages/tools/string-template-v2";

// Basic substitution
template("Hello {name}!", { name: "James" });
// => "Hello James!"

// Chained filters
template("{title|trim|upper}", { title: "  eight agent  " });
// => "EIGHT AGENT"

// Truncate with ellipsis
template("{bio|truncate:40}", { bio: "A very long biography that should be cut." });
// => "A very long biography that should be c..."

// Fallback when value is empty
template("{tagline|default:No tagline set}", { tagline: "" });
// => "No tagline set"

// Date formatting
template("Released: {date|date:YYYY-MM-DD}", { date: "2026-03-25T00:00:00Z" });
// => "Released: 2026-03-25"

// Custom filter
registerFilter("slug", (v) => v.toLowerCase().replace(/\s+/g, "-"));
template("{title|slug}", { title: "Hello World" });
// => "hello-world"
```

---

## Built-in filters

| Filter | Arg | Effect |
|--------|-----|--------|
| `upper` | - | Uppercase |
| `lower` | - | Lowercase |
| `trim` | - | Strip leading/trailing whitespace |
| `truncate:N` | max length | Truncate to N chars, append `...` |
| `default:val` | fallback | Use `val` when value is blank |
| `date:format` | format string | Format a date value (YYYY, MM, DD, iso, locale) |

---

## Options

```ts
template(str, data, {
  missing: "N/A",   // value used for missing keys (default: "")
  open:    "{{",    // opening delimiter (default: "{")
  close:   "}}",    // closing delimiter (default: "}")
});
```

---

## Integration checklist

- [ ] Decide: standalone util or replace existing string interpolation in system-prompt.ts?
- [ ] Wire into `packages/eight/prompts/system-prompt.ts` for USER_CONTEXT_SEGMENT rendering
- [ ] Expose via agent tool so Eight can call it at runtime
- [ ] Add tests under `benchmarks/categories/abilities/`
- [ ] If adopted: remove any ad-hoc string replacement logic it supersedes

---

## Why quarantine?

The 8gent codebase already does basic string interpolation inline at the call site (system-prompt.ts, memory injection, etc.). This package consolidates and upgrades that pattern. Before merging, confirm there is no duplication and identify all call sites that should migrate.
