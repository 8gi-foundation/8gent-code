# error-aggregate

**Tool name:** ErrorCollector

**Description:**
Collects multiple errors during a pass and surfaces them together as a native `AggregateError`. Prevents short-circuit failures in validation runs, parallel task execution, or any flow where all branches should complete before errors are raised. No external dependencies.

**Status:** quarantine

**Location:** `packages/tools/error-aggregate.ts`

**Exports:**
- `ErrorCollector` class
- `collectErrors(fns, labels?)` utility function
- `CollectedError` interface
- `FormatOptions` interface

**API surface:**
| Method / Function | Signature | Description |
|-------------------|-----------|-------------|
| `add` | `(error, label?)` | Add a single error with optional label |
| `addAll` | `(errors[])` | Add multiple errors or CollectedError objects at once |
| `hasErrors` | `()` | Returns true if at least one error collected |
| `count` | `()` | Number of collected errors |
| `errors` | `()` | Read-only snapshot of all collected errors |
| `toAggregateError` | `(message?)` | Convert to native AggregateError |
| `format` | `(opts?)` | Human-readable string, optional stack traces |
| `throw` | `(message?)` | Throw as AggregateError if errors exist; no-op if empty |
| `reset` | `()` | Clear all collected errors |
| `collectErrors` | `(fns, labels?)` | Run all fns, return collector with any failures |

**Usage example:**
```ts
import { ErrorCollector, collectErrors } from "../packages/tools/error-aggregate";

// Manual collection
const c = new ErrorCollector();
c.add(new Error("field required"), "email");
c.add(new Error("too short"), "password");
c.throw("Validation failed"); // throws AggregateError with both errors

// Run-all-collect pattern
const results = collectErrors([validateEmail, validateAge, validateName]);
if (results.hasErrors()) {
  console.error(results.format({ stacks: false }));
  results.throw();
}
```

**Integration path:**
1. Import into any validation pipeline, tool runner, or batch processor.
2. Replace `throw-on-first` patterns with `collector.add()` + `collector.throw()` at the end.
3. Surface `collector.format()` output in the debugger error panel or TUI alert component.
4. Wire into `packages/validation/meta-eval.ts` for multi-check evaluation passes.

**Promotion criteria:**
- [ ] Used in at least one validation pipeline (e.g. `packages/validation/` or `packages/permissions/`)
- [ ] `collectErrors` wired into a parallel tool-run path in `packages/eight/agent.ts`
- [ ] `format()` output surfaced in TUI or debugger on multi-error conditions
- [ ] No regressions in existing tool tests
