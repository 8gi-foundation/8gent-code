# image-hash

Perceptual image hash (pHash) for similarity detection.

## Requirements
- pHash(pixels, width, height, size?) returns bitstring
- hamming(hash1, hash2) returns distance 0-64
- isSimilar(hash1, hash2, threshold?) returns boolean
- normalize(pixels, width, height, size) downsizes and grayscales
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/image-hash.ts`
