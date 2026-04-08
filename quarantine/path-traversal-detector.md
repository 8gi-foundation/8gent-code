# path-traversal-detector

Detects path traversal attack patterns in URLs, file paths, and query parameters.

## Requirements
- detect(input): returns { vulnerable, patterns[] } for ../, ..\\ encoded variants
- normalize(path): resolves and normalizes a path for safe usage
- isWithinBase(basePath, filePath): checks filePath stays within basePath
- scan(inputs{}): scans multiple inputs, returns per-field results

## Status

Quarantine - pending review.

## Location

`packages/tools/path-traversal-detector.ts`
