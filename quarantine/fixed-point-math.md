# Quarantine: fixed-point-math

## What

Fixed-point decimal arithmetic to avoid floating-point precision errors. All values are stored internally as BigInt scaled by 10^precision, making every operation exact within the configured scale. Designed for financial calculations, benchmark scoring, and any domain where 0.1 + 0.2 === 0.3 must be true.

## File

`packages/tools/fixed-point-math.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { Decimal, decimal } from "./packages/tools/fixed-point-math.ts";

const a = decimal("0.1");
const b = decimal("0.2");

a.add(b).toString()    // "0.3"  (not "0.30000000000000004")
a.sub(b).toString()    // "-0.1"
a.mul(decimal("3")).toString()   // "0.3"
decimal("1").div(decimal("3")).toString()  // "0.3333333333"

decimal("1.456").round(2).toString()  // "1.46"
decimal("1.456").floor(2).toString()  // "1.45"
decimal("1.451").ceil(2).toString()   // "1.46"
decimal("-5.5").abs().toString()      // "5.5"

a.compareTo(b)   // -1 | 0 | 1
a.equals(b)      // false
decimal("3.14").toNumber()  // 3.14

const p4 = new Decimal("1.23456", 4);
p4.toString()   // "1.2345"
```

## Class and Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| Decimal | new Decimal(value, precision?) | Core class. value is string, number, or internal bigint. Default precision: 10. |
| decimal | (value, precision?) => Decimal | Factory shorthand. |
| .add | (other: Decimal) => Decimal | Addition. |
| .sub | (other: Decimal) => Decimal | Subtraction. |
| .mul | (other: Decimal) => Decimal | Multiplication (result re-scaled). |
| .div | (other: Decimal) => Decimal | Division. Throws on divide-by-zero. |
| .abs | () => Decimal | Absolute value. |
| .round | (decimalPlaces?) => Decimal | Round half-up to N places (default: 0). |
| .floor | (decimalPlaces?) => Decimal | Floor to N decimal places. |
| .ceil | (decimalPlaces?) => Decimal | Ceiling to N decimal places. |
| .compareTo | (other: Decimal) => -1 or 0 or 1 | Three-way comparison. |
| .equals | (other: Decimal) => boolean | Equality check. |
| .toString | () => string | Decimal string without trailing zeros. |
| .toNumber | () => number | JS float. Precision may degrade beyond 15 significant digits. |

## Constraints

- Both operands in arithmetic ops must share the same precision - throws otherwise.
- Precision is set at construction and immutable per instance.
- toNumber() is lossy for values exceeding JS float precision (~15-16 digits).

## Integration path

- [ ] Add export to packages/tools/index.ts
- [ ] Register as an agent-callable tool in packages/eight/tools.ts
- [ ] Add unit tests: 0.1+0.2===0.3, divide-by-zero throws, round/floor/ceil boundaries, negative values, precision mismatch throws, compareTo all three branches
- [ ] Use in benchmark scoring (benchmarks/autoresearch/) to avoid score drift from float accumulation
- [ ] Evaluate for financial calculations in packages/proactive/ opportunity pipeline
- [ ] Consider adding mod and pow operations if needed downstream
