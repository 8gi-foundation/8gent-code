# safe-eval-expression

## Description

Evaluates simple math and logic expressions from strings without using `eval()` or `Function()`. Supports variables via an optional map. Useful anywhere the agent needs to process user-supplied or config-defined expressions safely.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `evalExpr` | `(expr: string, vars?: VarMap) => number \| boolean \| string` | Evaluate a math/logic expression with optional variable substitution |

## Supported Operators

| Category | Operators |
|----------|-----------|
| Arithmetic | `+`, `-`, `*`, `/`, `%`, `**` |
| Comparison | `==`, `!=`, `>`, `<`, `>=`, `<=` |
| Logical | `&&`, `||`, `!` |
| Conditional | `? :` (ternary) |
| Grouping | `(` `)` |

## Usage

```typescript
import { evalExpr } from "./packages/tools/safe-eval-expression.ts";

evalExpr("2 + 3 * 4")                              // 14
evalExpr("2 ** 10")                                // 1024
evalExpr("x > 5 && y < 10", { x: 6, y: 3 })       // true
evalExpr("score >= 90 ? 'A' : 'B'", { score: 95 }) // "A"
evalExpr("(a + b) * c", { a: 2, b: 3, c: 4 })      // 20
```

## Security Properties

- No `eval()` or `new Function()` - cannot execute arbitrary code
- No property access on objects - only flat `VarMap` lookup
- No prototype chain access
- Throws on unknown variables rather than silently resolving to undefined
- Token-level input validation - rejects characters outside the allowed set

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/permissions/policy-engine.ts` to evaluate dynamic threshold conditions in YAML policies (e.g. `"token_count > 4096"`).
3. Use in `packages/validation/meta-eval.ts` for scoring expressions in benchmark harness config.
4. Use in `packages/proactive/` opportunity pipeline to evaluate numeric scoring rules without executing arbitrary code.

## Source

`packages/tools/safe-eval-expression.ts` - ~140 lines, zero dependencies, pure TypeScript.
