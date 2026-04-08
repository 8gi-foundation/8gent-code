# Quarantine: sandboxed-eval

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/sandboxed-eval.ts`

---

## What it does

Evaluates JavaScript expressions in a restricted scope with a configurable timeout. No external dependencies. No network, filesystem, or process access. Dangerous globals are explicitly shadowed to `undefined` before the user-supplied code runs.

| Function | Signature | Description |
|----------|-----------|-------------|
| `safeEval` | `(code, context?, timeout?) => Promise<EvalResult>` | Evaluate a JS expression or statement block in a sandboxed context. |

`EvalResult` shape:
```ts
{
  ok: boolean;
  value?: unknown;    // returned/resolved value on success
  error?: string;     // message on failure or timeout
  durationMs: number;
}
```

---

## CLI usage

```bash
bun packages/tools/sandboxed-eval.ts "1 + 2 * 3"
bun packages/tools/sandboxed-eval.ts "'hello world'.toUpperCase()"
bun packages/tools/sandboxed-eval.ts "JSON.parse('{\"x\": 1}').x"
```

---

## Programmatic usage

```ts
import { safeEval } from './packages/tools/sandboxed-eval.ts';

const r1 = await safeEval('2 ** 10');                     // { ok: true, value: 1024 }
const r2 = await safeEval('x * y', { x: 6, y: 7 });      // { ok: true, value: 42 }
const r3 = await safeEval('while(true){}', {}, 500);      // { ok: false, error: 'Timeout after 500ms' }
const r4 = await safeEval('typeof process');              // { ok: true, value: 'undefined' }
```

---

## Implementation notes

- Sandboxing via the `Function` constructor with an explicit parameter list that shadows every known dangerous global (`process`, `Bun`, `fetch`, `eval`, `Function`, `setTimeout`, etc.) to `undefined`.
- User context variables injected as additional parameters, validated against the block list.
- Code wrapped in an async IIFE so top-level `return` and `await` work without extra syntax from callers.
- Timeout enforced with `Promise.race` against a host-side `setTimeout` (sandbox's `setTimeout` is shadowed, so the timer is out of reach of evaluated code).
- Does not protect against CPU exhaustion from tight synchronous loops - use for trusted-but-untrusted input only (agent-generated expressions, calculator-style tools).

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry. Export the function and register it when needed.

Potential uses:
- Agent calculator tool - evaluate math/logic expressions the model generates
- Template engine - evaluate simple interpolations safely
- Benchmark harness - run scoring expressions without shell access
- REPL mode in the TUI debugger
