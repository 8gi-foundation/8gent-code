# interpolate-linear

Linear and bilinear interpolation functions.

## Requirements
- lerp(a, b, t) linear interpolation
- lerpClamped(a, b, t) clamps t to 0-1
- inverseLerp(a, b, value) returns t
- remap(value, inMin, inMax, outMin, outMax) remaps range
- bilinear(q11, q12, q21, q22, tx, ty) 2D interpolation

## Status

Quarantine - pending review.

## Location

`packages/tools/interpolate-linear.ts`
