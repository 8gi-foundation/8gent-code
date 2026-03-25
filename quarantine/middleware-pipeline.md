# Quarantine: middleware-pipeline

**Status:** Quarantine
**File:** `packages/tools/middleware-pipeline.ts`

## What it does

`Pipeline<T>` class for chaining async middleware over a shared context object.

- `pipeline.use(middleware)` - register middleware, runs in order
- `pipeline.catch(errorHandler)` - register error handlers, called on throw
- `pipeline.execute(ctx)` - run the chain, returns mutated context
- `Pipeline.compose(...pipelines)` - merge multiple pipelines
- `createPipeline<T>()` - convenience factory

## Integration candidates

- `packages/eight/agent.ts` - pre/post tool-call hooks
- `packages/permissions/policy-engine.ts` - layered policy checks
- `packages/orchestration/` - sub-agent delegation chain

## Promotion criteria

- [ ] At least one integration using it in production code
- [ ] Error handler path tested with a real failure case
- [ ] Benchmarked: overhead < 1ms per middleware layer
