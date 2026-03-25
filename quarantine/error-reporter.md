# error-reporter

**Tool name:** ErrorReporter

**Description:**
Captures errors with optional context, auto-deduplicates by normalizing numeric and hex variants in the message, and generates frequency-aware summary reports. Useful anywhere multiple errors can occur in a session and you want a single structured view rather than scattered throws. No external dependencies.

**Status:** quarantine

**Location:** `packages/tools/error-reporter.ts`

**Exports:**
- `ErrorReporter` class
- `errorReporter` singleton
- `CapturedError` interface
- `ErrorSummary` interface

**API surface:**
| Method | Signature | Description |
|--------|-----------|-------------|
| `capture` | `(error, context?)` | Record an error; deduplicates on type + normalized message |
| `getErrors` | `()` | All captured errors as array |
| `getByType` | `(type)` | Filter errors by constructor name |
| `frequency` | `()` | All errors sorted by occurrence count descending |
| `recentErrors` | `(n?)` | n most recently seen errors (default 10) |
| `summary` | `()` | Totals, unique count, top-5 by frequency, timespan |
| `clear` | `()` | Reset all captured errors |

**Usage example:**
```ts
import { errorReporter } from "../packages/tools/error-reporter";

// Capture during a run
errorReporter.capture(new TypeError("Cannot read properties of null"), { tool: "bash" });
errorReporter.capture(new TypeError("Cannot read properties of null"), { tool: "read" }); // deduped, count -> 2
errorReporter.capture(new Error("ENOENT: no such file"), { path: "/tmp/x" });

// Inspect
const s = errorReporter.summary();
// { total: 3, unique: 2, topErrors: [...], timespan: { firstAt, lastAt } }

const top = errorReporter.frequency();
// [TypeError x2, Error x1]

const recent = errorReporter.recentErrors(5);

errorReporter.clear();
```

**Integration path:**
1. Import `errorReporter` singleton into `packages/eight/agent.ts` tool-call catch blocks.
2. Surface `summary()` in the TUI debugger panel at end of session.
3. Pipe `frequency()` into `packages/self-autonomy/reflection.ts` post-session analysis.
4. Wire into `packages/validation/meta-eval.ts` to aggregate eval failures across a run.

**Promotion criteria:**
- [ ] `capture()` wired into at least one agent tool error path in `packages/eight/agent.ts`
- [ ] `summary()` output surfaced in TUI or debugger on session end
- [ ] Used in at least one validation or reflection pipeline
- [ ] No regressions in existing tool tests
