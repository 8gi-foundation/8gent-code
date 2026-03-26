# video-duration

Parse video duration from MP4/WebM container headers.

## Requirements
- parse(buffer) returns {duration, format} or null
- MP4: reads mvhd box for duration and timescale
- WebM: reads EBML Segment Duration element
- Supports partial buffer (first 1MB sufficient)
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/video-duration.ts`
