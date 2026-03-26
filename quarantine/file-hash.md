# file-hash

Hash file contents using various algorithms.

## Requirements
- hashBuffer(buffer, algorithm) returns hex digest
- Supports md5, sha1, sha256, sha512
- hashString(str, algorithm) hashes UTF-8 string
- compare(hash1, hash2) timing-safe compare
- Uses Node crypto module

## Status

Quarantine - pending review.

## Location

`packages/tools/file-hash.ts`
