# Quarantine: matrix-2d

## What

Immutable 2D affine transformation matrix for graphics, layout, and CSS output. Stores transforms as a standard CSS-compatible 6-element matrix (a,b,c,d,e,f) and supports chained translate, scale, rotate, skew, multiply, and inverse operations. Output includes `matrix()` and `matrix3d()` CSS strings and a `decompose()` call that extracts translate/scale/rotate/skew components.

## File

`packages/tools/matrix-2d.ts` (~135 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { Matrix2D } from './packages/tools/matrix-2d.ts';
import type { Point, Decomposed, MatrixValues } from './packages/tools/matrix-2d.ts';

// Identity
const m = Matrix2D.identity();

// Chained transforms (immutable - each returns a new instance)
const t = Matrix2D.identity()
  .translate(100, 50)
  .rotate(Math.PI / 4)
  .scale(2);

// Multiply two matrices
const combined = a.multiply(b);

// Inverse
const inv = t.inverse(); // throws if determinant is zero

// Transform a point
const p: Point = t.transformPoint({ x: 10, y: 20 });

// CSS output
t.toCSS();   // "matrix(1.414214,1.414214,-1.414214,1.414214,70.710678,106.066017)"
t.toCSS3d(); // "matrix3d(...)"

// Decompose into components
const d: Decomposed = t.decompose();
// { translateX, translateY, scaleX, scaleY, rotation, skewX }

// Build from raw values
const raw = Matrix2D.fromValues(1, 0, 0, 1, 50, 100);
raw.isIdentity(); // false
raw.determinant(); // 1
raw.values();     // [1, 0, 0, 1, 50, 100]
```

## Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `identity` | `() => Matrix2D` | Returns a new identity matrix |
| `fromValues` | `(a,b,c,d,e,f) => Matrix2D` | Builds from raw CSS matrix values |
| `multiply` | `(other: Matrix2D) => Matrix2D` | Matrix multiplication (this * other) |
| `translate` | `(tx, ty) => Matrix2D` | Appends a translation |
| `scale` | `(sx, sy?) => Matrix2D` | Appends a scale (uniform if sy omitted) |
| `rotate` | `(angle) => Matrix2D` | Appends a rotation (radians) |
| `skew` | `(ax, ay?) => Matrix2D` | Appends a skew (radians) |
| `inverse` | `() => Matrix2D` | Returns the inverse, throws if singular |
| `transformPoint` | `(p: Point) => Point` | Applies the transform to a 2D point |
| `decompose` | `() => Decomposed` | Extracts translate/scale/rotate/skew |
| `toCSS` | `() => string` | CSS `matrix(a,b,c,d,e,f)` string |
| `toCSS3d` | `() => string` | CSS `matrix3d(...)` string for 3D layers |
| `values` | `() => MatrixValues` | Returns a copy of the 6-element array |
| `determinant` | `() => number` | Scalar determinant (ad - bc) |
| `isIdentity` | `() => boolean` | True if all values match identity |

## Integration path

- [ ] Add export to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: identity round-trip, translate/scale/rotate composition, inverse of singular matrix throws, transformPoint against known values, toCSS format, decompose accuracy
- [ ] Use in TUI layout calculations where CSS-like transform chains are needed (e.g., canvas overlays, animated panels)
- [ ] Consider using in `apps/demos/` for 2D scene graph composition
- [ ] Evaluate adding `lerp(other, t)` for animation interpolation between two matrices
