/**
 * data-pipeline.ts
 * ETL-style composable data pipeline with per-stage error handling and stats.
 */

export type StageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error; input: unknown };

export interface PipelineStats {
  extracted: number;
  transformed: number;
  filtered: number;
  validated: number;
  loaded: number;
  errors: Array<{ stage: string; error: string; input: unknown }>;
  durationMs: number;
}

export interface PipelineOptions {
  continueOnError?: boolean;
  onStageError?: (stage: string, error: Error, input: unknown) => void;
}

type TransformFn<I, O> = (item: I) => O | Promise<O>;
type FilterFn<T> = (item: T) => boolean | Promise<boolean>;
type ValidateFn<T> = (item: T) => boolean | string | Promise<boolean | string>;
type LoadFn<T> = (items: T[]) => void | Promise<void>;

interface Stage {
  name: string;
  run: (items: unknown[]) => Promise<unknown[]>;
}

export class Pipeline<T> {
  private stages: Stage[] = [];
  private stats: Omit<PipelineStats, "durationMs"> = {
    extracted: 0,
    transformed: 0,
    filtered: 0,
    validated: 0,
    loaded: 0,
    errors: [],
  };
  private opts: PipelineOptions;

  constructor(opts: PipelineOptions = {}) {
    this.opts = { continueOnError: true, ...opts };
  }

  extract(source: T[] | (() => T[] | Promise<T[]>)): this {
    this.stages.push({
      name: "extract",
      run: async () => {
        const items = typeof source === "function" ? await source() : source;
        this.stats.extracted = items.length;
        return items as unknown[];
      },
    });
    return this;
  }

  transform<O>(fn: TransformFn<T, O>): Pipeline<O> {
    const next = new Pipeline<O>(this.opts);
    next.stages = [...this.stages];
    next.stats = this.stats;
    next.stages.push({
      name: "transform",
      run: async (items) => {
        const results: unknown[] = [];
        for (const item of items) {
          try {
            results.push(await fn(item as T));
            this.stats.transformed++;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errors.push({ stage: "transform", error: error.message, input: item });
            this.opts.onStageError?.("transform", error, item);
            if (!this.opts.continueOnError) throw error;
          }
        }
        return results;
      },
    });
    return next;
  }

  filter(pred: FilterFn<T>): this {
    this.stages.push({
      name: "filter",
      run: async (items) => {
        const kept: unknown[] = [];
        for (const item of items) {
          try {
            if (await pred(item as T)) kept.push(item);
            this.stats.filtered++;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errors.push({ stage: "filter", error: error.message, input: item });
            this.opts.onStageError?.("filter", error, item);
            if (!this.opts.continueOnError) throw error;
          }
        }
        return kept;
      },
    });
    return this;
  }

  validate(schema: ValidateFn<T>): this {
    this.stages.push({
      name: "validate",
      run: async (items) => {
        const valid: unknown[] = [];
        for (const item of items) {
          try {
            const result = await schema(item as T);
            if (result === true) {
              valid.push(item);
              this.stats.validated++;
            } else {
              const msg = typeof result === "string" ? result : "Validation failed";
              this.stats.errors.push({ stage: "validate", error: msg, input: item });
              this.opts.onStageError?.("validate", new Error(msg), item);
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.stats.errors.push({ stage: "validate", error: error.message, input: item });
            this.opts.onStageError?.("validate", error, item);
            if (!this.opts.continueOnError) throw error;
          }
        }
        return valid;
      },
    });
    return this;
  }

  load(dest: LoadFn<T>): this {
    this.stages.push({
      name: "load",
      run: async (items) => {
        await dest(items as T[]);
        this.stats.loaded = items.length;
        return items;
      },
    });
    return this;
  }

  async run(): Promise<PipelineStats> {
    const start = Date.now();
    let current: unknown[] = [];
    for (const stage of this.stages) {
      current = await stage.run(current);
    }
    return { ...this.stats, durationMs: Date.now() - start };
  }
}
