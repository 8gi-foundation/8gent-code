# lfu-cache

Least Frequently Used cache eviction policy.

## Requirements
- LFUCache<K, V>(capacity) evicts least-frequently-used entries
- get(key) returns value and increments frequency
- set(key, value) adds or updates
- Ties broken by recency (LRU among equal frequencies)
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/lfu-cache.ts`
