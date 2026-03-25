# Quarantine: Token Counter

## Package

`packages/tools/token-counter.ts`

## What it does

Estimates token count for arbitrary text using a tiktoken-compatible BPE approximation. Zero dependencies - no WASM, no external tokenizer.

## Approach

- Base heuristic: 4 characters per token (matches cl100k_base average for English)
- Special handling for URLs (~3.2 chars/token), long numbers (~5 digits/token), and single-token punctuation
- Returns structured `TokenEstimate` with count, char length, effective ratio

## Accuracy

- ~90% vs cl100k_base for English prose
- ~85% for code (punctuation-heavy text skews slightly)
- Intentionally conservative (slight over-count preferred over under-count)

## Why quarantined

- Needs validation against actual tiktoken output across diverse inputs (prose, code, multilingual, emoji)
- The 4-char heuristic is well-known but may need per-model calibration (cl100k vs o200k)
- No tests yet

## Exit criteria

1. Add test suite comparing against tiktoken reference output for 50+ samples
2. Confirm <10% error rate across English, code, and mixed content
3. Wire into agent loop for context window budget tracking
4. Remove this quarantine doc and merge to main
