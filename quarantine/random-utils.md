# Quarantine: random-utils

**Status:** quarantine
**File:** `packages/tools/random-utils.ts`
**Added:** 2026-03-25

## What it does

Cryptographically secure random utilities built on `crypto.getRandomValues`. Zero
dependencies, no `Math.random` anywhere.

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `randomInt` | `(min: number, max: number) => number` | Integer in [min, max] inclusive |
| `randomFloat` | `(min: number, max: number) => number` | Float in [min, max) with 53-bit resolution |
| `randomChoice` | `<T>(arr: readonly T[]) => T \| undefined` | Single random element |
| `randomSample` | `<T>(arr: readonly T[], n: number) => T[]` | n unique elements without replacement |
| `shuffle` | `<T>(arr: readonly T[]) => T[]` | Fisher-Yates full shuffle (non-mutating) |
| `randomString` | `(len: number, charset?: string) => string` | Random string from optional charset |
| `randomHex` | `(len: number) => string` | Lowercase hex string |
| `coinFlip` | `() => boolean` | 50/50 boolean |

## Design decisions

- **Rejection sampling** on both `randomInt` and `randomString` to eliminate modulo bias.
- **53 bits** of float entropy (hi 27 bits + lo 26 bits) matching IEEE 754 double precision.
- **Non-mutating** - `shuffle` and `randomSample` return new arrays; inputs are untouched.
- **Charset limited to 256 chars** - keeps rejection sampling within a single byte per character.

## Promotion checklist

- [ ] Unit tests covering all 8 exports
- [ ] Edge case coverage: empty arrays, len=0, min===max, n===0
- [ ] Bias verification test (chi-squared or frequency check)
- [ ] Integration: wire into agent tools registry (`packages/eight/tools.ts`) if needed
- [ ] Peer review
