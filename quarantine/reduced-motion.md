# reduced-motion

Respect prefers-reduced-motion in animation configs.

## Requirements
- MotionConfig: duration, easing, enabled
- reduced(config) returns zero-duration config if motion is reduced
- isReduced(mediaQueryList?) detects preference
- withMotion(full, reduced) picks config based on preference
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/reduced-motion.ts`
