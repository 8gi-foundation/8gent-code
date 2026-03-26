# exif-parse

Extract EXIF metadata from JPEG files (minimal parser).

## Requirements
- parse(buffer) returns key EXIF fields: make, model, dateTime, width, height
- Reads APP1 marker and IFD0 tags
- Returns null on parse error
- Zero dependencies
- Read-only, no write support

## Status

Quarantine - pending review.

## Location

`packages/tools/exif-parse.ts`
