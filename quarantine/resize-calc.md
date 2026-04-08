# resize-calc

Calculate resize dimensions preserving aspect ratio.

## Requirements
- fit(srcW, srcH, maxW, maxH) returns {width, height} within bounds
- fill(srcW, srcH, targetW, targetH) returns crop rect
- cover(srcW, srcH, targetW, targetH) returns scale factor
- contain(srcW, srcH, targetW, targetH) returns scale factor
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/resize-calc.ts`
