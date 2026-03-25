/**
 * Composable middleware pipeline with context passing.
 * Koa-style: middleware receives (ctx, next) and calls next() to proceed.
 */

export type Next = () => Promise<void>;

export type Middleware<T extends object = Record<string, unknown>> = (
  ctx: T,
  next: Next
) => Promise<void>;

export type ErrorMiddleware<T extends object = Record<string, unknown>> = (
  err: unknown,
  ctx: T,
  next: Next
) => Promise<void>;

export class Pipeline<T extends object = Record<string, unknown>> {
  private middlewares: Middleware<T>[] = [];
  private errorHandlers: ErrorMiddleware<T>[] = [];

  use(middleware: Middleware<T>): this {
    this.middlewares.push(middleware);
    return this;
  }

  catch(handler: ErrorMiddleware<T>): this {
    this.errorHandlers.push(handler);
    return this;
  }

  async execute(ctx: T): Promise<T> {
    await this.runMiddleware(ctx, this.middlewares, 0);
    return ctx;
  }

  private async runMiddleware(ctx: T, stack: Middleware<T>[], index: number): Promise<void> {
    if (index >= stack.length) return;
    const current = stack[index];
    let nextCalled = false;
    const next: Next = async () => {
      if (nextCalled) throw new Error("next() called multiple times at " + index);
      nextCalled = true;
      await this.runMiddleware(ctx, stack, index + 1);
    };
    try {
      await current(ctx, next);
    } catch (err) {
      await this.runErrorHandlers(err, ctx, 0);
    }
  }

  private async runErrorHandlers(err: unknown, ctx: T, index: number): Promise<void> {
    if (index >= this.errorHandlers.length) throw err;
    const handler = this.errorHandlers[index];
    let nextCalled = false;
    const next: Next = async () => {
      if (nextCalled) throw new Error("next() called multiple times in error handler " + index);
      nextCalled = true;
      await this.runErrorHandlers(err, ctx, index + 1);
    };
    await handler(err, ctx, next);
  }

  static compose<T extends object = Record<string, unknown>>(
    ...pipelines: Pipeline<T>[]
  ): Pipeline<T> {
    const combined = new Pipeline<T>();
    for (const p of pipelines) {
      for (const m of (p as any).middlewares) combined.use(m);
      for (const e of (p as any).errorHandlers) combined.catch(e);
    }
    return combined;
  }
}

export function createPipeline<T extends object = Record<string, unknown>>(): Pipeline<T> {
  return new Pipeline<T>();
}
