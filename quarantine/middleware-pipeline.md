# Quarantine: middleware-pipeline

**Status:** Quarantine
**File:** `packages/tools/middleware-pipeline.ts`
**Pattern:** Koa-style composable middleware pipeline

## What it does

Provides a `Pipeline<T>` class for chaining async middleware over a shared context.

- `pipeline.use(middleware)` - register middleware, runs in order
- `pipeline.catch(errorHandler)` - register error handlers, called on throw
- `pipeline.execute(ctx)` - run the chain, returns mutated context
- `Pipeline.compose(...pipelines)` - merge multiple pipelines
- `createPipeline<T>()` - convenience factory

## Middleware signature

```ts
type Middleware<T> = (ctx: T, next: Next) => Promise<void>
type ErrorMiddleware<T> = (err: unknown, ctx: T, next: Next) => Promise<void>
```

## Usage example

```ts
import { createPipeline } from "./packages/tools/middleware-pipeline";

type Ctx = { user?: string; authorized?: boolean; result?: string };

const pipeline = createPipeline<Ctx>()
  .use(async (ctx, next) => {
    ctx.authorized = ctx.user === "admin";
    await next();
  })
  .use(async (ctx, next) => {
    if (\!ctx.authorized) throw new Error("Unauthorized");
    ctx.result = "done";
    await next();
  })
  .catch(async (err, ctx, next) => {
    console.error("Pipeline error:", err);
  });

const ctx = await pipeline.execute({ user: "admin" });
// ctx.result === "done"
```

## Integration candidates

- `packages/eight/agent.ts` - pre/post tool-call hooks
- `packages/permissions/policy-engine.ts` - layered policy checks
- `packages/orchestration/` - sub-agent delegation chain

## Promotion criteria

- [ ] At least one integration using it in production code
- [ ] Error handler path tested with a real failure case
- [ ] Benchmarked: overhead < 1ms per middleware layer
