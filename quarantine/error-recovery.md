# Quarantine: Error Recovery Benchmark

## What

`benchmarks/categories/abilities/error-recovery.ts` - benchmark that tests the agent's ability to recover from tool failures, retry with alternative strategies, report errors clearly, and use the checkpoint-verify-revert healing loop.

## Status

Quarantined - new benchmark file, no existing files modified.

## ID

AB007

## Tests

| # | Test | What it validates |
|---|------|-------------------|
| 1 | Tool call recovery | SelfHealer retries after a simulated tool failure (broken syntax on first 2 attempts, valid on 3rd) |
| 2 | Alternative approach retry | Agent switches strategy when the first approach throws, verifies multiple strategies are attempted |
| 3 | Clear error reporting | Failure log captures output from failed checks with non-empty entries |
| 4 | Checkpoint-verify-revert | createCheckpoint + destructive write + restoreCheckpoint returns file to original content |

## Dependencies

- `packages/validation/healing.ts` - SelfHealer class
- `packages/validation/checkpoint.ts` - createCheckpoint, restoreCheckpoint, dropCheckpoint

## Usage

```bash
bun run benchmarks/categories/abilities/error-recovery.ts
```

## Success criteria

All 4 tests pass. Each is weighted equally at 0.25 in the harness scoring descriptor.

## Risk

Low. Creates one new benchmark file and this quarantine doc. Touches zero existing files. Runs in tmp directories with full cleanup.
