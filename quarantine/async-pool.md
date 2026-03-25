# async-pool

Limit concurrent async tasks with a promise pool.

## Requirements
- pool(tasks: (() => Promise<T>)[], concurrency: number) -> Promise<T[]>
- Preserves result order matching input order
- Starts new tasks as slots free
- Propagates first rejection (fail-fast mode)
- allSettled mode option to collect all results

## Status

Quarantine - pending review.

## Location

`packages/tools/async-pool.ts`
