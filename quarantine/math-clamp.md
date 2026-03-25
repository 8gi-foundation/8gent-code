# Quarantine: math-clamp

**Status:** Quarantined - awaiting review and integration decision.

**File:** `packages/tools/math-clamp.ts`

---

## What it does

Numeric utility functions for UI layout, animation, value mapping, and general math operations.

## Exported functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `clamp` | `(val, min, max) => number` | Constrain value to [min, max] range |
| `lerp` | `(a, b, t) => number` | Linear interpolation between two values |
| `inverseLerp` | `(a, b, val) => number` | Inverse lerp - returns t for a given value |
| `remap` | `(val, inMin, inMax, outMin, outMax) => number` | Map value from one range to another |
| `roundTo` | `(val, decimals) => number` | Round to N decimal places |
| `snap` | `(val, step) => number` | Snap value to nearest multiple of step |
| `wrap` | `(val, min, max) => number` | Wrap value into [min, max) cyclically |
| `distance` | `(a, b) => number` | Absolute distance between two 1D points |
| `sign` | `(val) => -1 | 0 | 1` | Sign of a number |
| `isInRange` | `(val, min, max, exclusive?) => boolean` | Check if value falls within a range |

## Use cases

- **Layout:** Clamping scroll offsets, panel widths, or progress values.
- **Animation:** Lerp and remap for smooth transitions between states.
- **Input handling:** Snap for grid-aligned dragging. Wrap for cyclic inputs (angles, carousel indices).
- **Formatting:** roundTo for display-safe numeric output.
- **Validation:** isInRange for bounds checking.

## Why quarantined

Standard numeric utilities. No dependencies. Zero risk. Pending a decision on whether to wire into `packages/tools/index.ts` or use ad hoc.

## Integration path

```ts
// Option A: import directly
import { clamp, lerp } from './packages/tools/math-clamp.ts';

// Option B: re-export from packages/tools/index.ts
export * from './math-clamp.ts';
```

## Testing notes

All functions include JSDoc examples. Edge cases handled:
- `clamp`: throws if min > max
- `inverseLerp`: throws if a === b (division by zero)
- `snap`: throws if step <= 0
- `wrap`: throws if min >= max
- `isInRange`: optional `exclusive` flag for open interval checks
