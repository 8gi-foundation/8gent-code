# Quarantine: sandboxed-eval

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/sandboxed-eval.ts`

---

## What it does

Evaluates JavaScript expressions in a restricted scope with a configurable timeout. No external dependencies. No network, filesystem, or process access. Dangerous globals are explicitly shadowed to `undefined` before user-supplied code runs.

| Function | Signature | Description |
|----------|-----------|-------------|
| `safeEval` | `(code, context?, timeout?) => Promise<EvalResult>` | Evaluate a JS expression or statement block in a sandboxed context. |

`EvalResult` shape:
```ts
{ ok: boolean; value?: unknown; error?: string; durationMs: number; }
```

---

## CLI usage

```bash
bun packages/tools/sandboxed-eval.ts "1 + 2 * 3"
bun packages/tools/sandboxed-eval.ts "'hello'.toUpperCase()"
bun packages/tools/sandboxed-eval.ts "typeof process"
```

---

## Programmatic usage

```ts
import { safeEval } from './packages/tools/sandboxed-eval.ts';
const r1 = await safeEval('2 ** 10');                  // { ok: true, value: 1024 }
const r2 = await safeEval('x * y', { x: 6, y: 7 });   // { ok: true, value: 42 }
const r3 = await safeEval('while(true){}', {}, 500);   // { ok: false, error: 'Timeout...' }
const r4 = await safeEval('typeof process');           // { ok: true, value: 'undefined' }
```

---

## Implementation notes

- Sandboxing via the `Function` constructor - explicit parameter list shadows every known dangerous global to `undefined`.
- User context variables injected as additional parameters, validated against the block list.
- Code wrapped in an async IIFE so top-level `return` and `await` work.
- Timeout enforced with `Promise.race` against a host-side `setTimeout` (sandbox timer is shadowed).
- Does not protect against CPU exhaustion from tight synchronous loops.

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry.

Potential uses: agent calculator, template engine interpolations, benchmark harness scoring, TUI debugger REPL.
