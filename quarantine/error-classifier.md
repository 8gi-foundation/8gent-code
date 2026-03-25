# Quarantine: Error Classifier

## Status

Quarantined - not wired into agent loop or package exports.

## What it does

Classifies errors by category and returns structured recovery guidance for agent self-healing. Accepts any `unknown` thrown value and returns a `ClassifiedError` with category, severity, stack frames, retry flag, and ordered recovery actions.

Supported categories:

- **network** - connection refused, DNS failure, socket reset, fetch errors
- **auth** - 401/403, invalid/expired tokens, API key failures
- **permission** - EACCES/EPERM, access denied, insufficient privileges
- **syntax** - SyntaxError, malformed JSON/YAML, unexpected tokens
- **runtime** - TypeError, ReferenceError, null dereference, stack overflow
- **timeout** - ETIMEDOUT, deadline exceeded, request too long
- **unknown** - catch-all with escalation guidance

## File

`packages/tools/error-classifier.ts` (~135 lines)

## Usage

```typescript
import { classifyError } from "./packages/tools/error-classifier.ts";

try {
  await riskyOperation();
} catch (err) {
  const result = classifyError(err);
  console.log(result.category);        // "network"
  console.log(result.retryable);       // true
  console.log(result.recoveryActions); // ["Retry with exponential backoff", ...]
}
```

## Integration path

1. Wire into `packages/eight/agent.ts` catch block - call `classifyError` and attach to tool-call error event
2. Surface `recoveryActions[0]` in the TUI as a suggested next step when a tool fails
3. Use `retryable` flag to drive the retry policy in `packages/validation/healing.ts`
4. Export from `packages/tools/index.ts` once integration tests cover all six categories

## Before promoting

- [ ] Add unit tests covering all six categories with representative error messages
- [ ] Wire into agent error handler in `packages/eight/agent.ts`
- [ ] Expose `recoveryActions` in TUI tool-failure panel
- [ ] Add to `packages/tools/index.ts` exports
- [ ] Validate stack frame parsing against Bun and V8 stack formats
