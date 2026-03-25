# string-scanner

**Status:** Quarantine - awaiting integration review

## What it does

Cursor-based string scanner for building parsers. Wraps a source string with a movable cursor and a set of match/advance primitives - no ad-hoc regex or index arithmetic needed by the caller.

| Export | Description |
|--------|-------------|
| `StringScanner` | Main class. Construct with a source string, then scan through it. |

## API

```ts
const s = new StringScanner(source);

s.scan(pattern)       // Match at cursor, advance on success. Returns matched string or null.
s.check(pattern)      // Lookahead - match at cursor without advancing. Returns match or null.
s.advance(n?)         // Skip n characters (default 1). Returns skipped string or null at eos.
s.peek(n?)            // Peek at next n characters without advancing.
s.scanUntil(pattern)  // Advance up to (not including) the next match. Returns skipped string.
s.reset(pos?)         // Reset cursor to pos (default 0).

s.position            // Current cursor index.
s.matched             // Last string returned by scan() / advance(). Null before first match.
s.eos                 // True when cursor is at end of string.
s.rest                // Remaining unscanned portion of the source.
s.toString()          // Full source string.
```

`pattern` accepts a `string` (literal match) or `RegExp`. Strings are auto-escaped. RegExps are auto-anchored to the current cursor position.

## Usage

```ts
import { StringScanner } from "../packages/tools/string-scanner";

const s = new StringScanner("name: Alice, age: 30");

s.scan(/\w+/);      // "name"
s.scan(/:\s*/);     // ": "
s.scan(/\w+/);      // "Alice"
s.scan(/,\s*/);     // ", "
s.scan(/\w+/);      // "age"
s.scan(/:\s*/);     // ": "
s.scan(/\d+/);      // "30"
s.eos;              // true

// Lookahead without advancing
const t = new StringScanner("<tag>");
t.check(/</);       // "<" - cursor still at 0
t.scan(/<(\w+)>/);  // "<tag>"

// Skip to delimiter
const u = new StringScanner("prefix::target");
u.scanUntil(/::/);  // "prefix"
u.advance(2);       // "::"
u.rest;             // "target"
```

## File

`packages/tools/string-scanner.ts` - 140 lines, zero dependencies.

## Integration candidates

- `packages/eight/` - command/expression tokenizer for agent DSL
- `packages/permissions/policy-engine.ts` - YAML policy token scanning
- `packages/memory/` - lightweight log/trace line parser
- Any module currently using ad-hoc `indexOf` + `slice` for incremental parsing
