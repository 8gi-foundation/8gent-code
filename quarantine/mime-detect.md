# mime-detect

Detect MIME type from file magic bytes (no extension lookup).

## Requirements
- detect(buffer) returns MIME type string or null
- Supports JPEG, PNG, GIF, WebP, MP4, WebM, MP3, PDF, ZIP, GZIP
- getMagic(buffer) returns hex signature
- isImage(buffer) boolean helper
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/mime-detect.ts`
