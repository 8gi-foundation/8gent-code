# log-rotate

Log rotation for file-based loggers.

## Requirements
- RotatingLogger class wrapping file write
- Rotate by size (maxBytes) and age (maxDays)
- Keep N rotated files, delete older ones
- Atomic rename-based rotation (no log loss)
- Works on macOS and Linux

## Status

Quarantine - pending review.

## Location

`packages/tools/log-rotate.ts`
