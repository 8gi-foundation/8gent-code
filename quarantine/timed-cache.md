# timed-cache

Cache with per-entry TTL and lazy eviction.

## Requirements
- TimedCache<K, V>(defaultTTL) stores entries with expiry
- get(key) returns value or undefined if expired
- set(key, value, ttl?) overrides default TTL
- has(key) returns true if present and not expired
- delete(key) explicit removal

## Status

Quarantine - pending review.

## Location

`packages/tools/timed-cache.ts`
