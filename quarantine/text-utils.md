# text-utils

Zero-dependency text utility library for terminal and general string manipulation.

## Location

`packages/tools/text-utils.ts`

## Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `truncate` | `(text: string, maxLength: number, suffix?: string) => string` | Truncate at word boundaries, append suffix (default "...") |
| `wordWrap` | `(text: string, width: number) => string[]` | Wrap text to column width, returns array of lines |
| `stripAnsi` | `(text: string) => string` | Remove all ANSI escape codes |
| `slugify` | `(text: string) => string` | URL/filesystem-safe slug (lowercase, hyphens) |
| `pluralize` | `(count: number, word: string, plural?: string) => string` | Singular/plural form with count prefix |
| `humanizeBytes` | `(bytes: number, decimals?: number) => string` | Byte count to human-readable string (IEC base-1024) |
| `humanizeDuration` | `(ms: number) => string` | Milliseconds to human-readable duration |

## Usage

```ts
import {
  truncate,
  wordWrap,
  stripAnsi,
  slugify,
  pluralize,
  humanizeBytes,
  humanizeDuration,
} from "./packages/tools/text-utils.ts";

truncate("Hello world, this is a long sentence", 20);
// => "Hello world, this..."

wordWrap("The quick brown fox jumps over the lazy dog", 20);
// => ["The quick brown fox", "jumps over the lazy", "dog"]

stripAnsi("\u001b[32mgreen text\u001b[0m");
// => "green text"

slugify("Hello World! 2026");
// => "hello-world-2026"

pluralize(1, "file");       // => "1 file"
pluralize(3, "file");       // => "3 files"
pluralize(2, "person", "people"); // => "2 people"

humanizeBytes(0);           // => "0 B"
humanizeBytes(1024);        // => "1 KB"
humanizeBytes(1536000);     // => "1.46 MB"

humanizeDuration(350);      // => "350ms"
humanizeDuration(4500);     // => "4s"
humanizeDuration(135000);   // => "2m 15s"
humanizeDuration(3780000);  // => "1h 3m"
```

## Notes

- Zero external dependencies - uses only TypeScript primitives.
- `truncate` walks backwards from the cut point to find the nearest space, preventing mid-word breaks.
- `wordWrap` handles multi-paragraph text (newline-delimited) and preserves empty lines.
- `stripAnsi` covers both ESC[ (CSI) sequences and C1 control codes.
- `humanizeBytes` uses IEC base-1024 (KB = 1024 B), not SI base-1000.
- `humanizeDuration` rounds milliseconds; sub-second values show "ms", not fractional seconds.

## Status

Quarantined - safe to wire into TUI lib or any package that needs these primitives.
