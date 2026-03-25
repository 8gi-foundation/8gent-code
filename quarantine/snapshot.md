# snapshot

Snapshot testing utilities for serializing and comparing values.

## Requirements
- serialize(value) -> string deterministic representation
- matchSnapshot(value, name) compares against stored snapshot
- updateSnapshot(name, value) saves new baseline
- Snapshot stored as JSON file in __snapshots__
- diff output when mismatch detected

## Status

Quarantine - pending review.

## Location

`packages/tools/snapshot.ts`
