/**
 * ResultCollector - collects success/failure results from multiple operations.
 *
 * Usage:
 *   const collector = new ResultCollector<string>();
 *   collector.addSuccess("file written");
 *   collector.addFailure(new Error("network timeout"));
 *   console.log(collector.summary());
 */

export interface SuccessResult<T> {
  ok: true;
  value: T;
  timestamp: number;
}

export interface FailureResult {
  ok: false;
  error: Error | string;
  timestamp: number;
}

export type CollectedResult<T> = SuccessResult<T> | FailureResult;

export interface CollectorSummary {
  total: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  failures: string[];
}

export class ResultCollector<T = unknown> {
  private results: CollectedResult<T>[] = [];

  /**
   * Add a pre-built result (success or failure).
   */
  add(result: CollectedResult<T>): this {
    this.results.push(result);
    return this;
  }

  /**
   * Record a successful operation with its value.
   */
  addSuccess(value: T): this {
    this.results.push({ ok: true, value, timestamp: Date.now() });
    return this;
  }

  /**
   * Record a failed operation with its error.
   */
  addFailure(error: Error | string): this {
    this.results.push({ ok: false, error, timestamp: Date.now() });
    return this;
  }

  /**
   * Return all successful results.
   */
  successes(): SuccessResult<T>[] {
    return this.results.filter((r): r is SuccessResult<T> => r.ok);
  }

  /**
   * Return all failed results.
   */
  failures(): FailureResult[] {
    return this.results.filter((r): r is FailureResult => !r.ok);
  }

  /**
   * True if any failures have been recorded.
   */
  hasFailures(): boolean {
    return this.results.some((r) => !r.ok);
  }

  /**
   * Ratio of successes to total results. Returns 0 when empty.
   */
  successRate(): number {
    if (this.results.length === 0) return 0;
    return this.successes().length / this.results.length;
  }

  /**
   * Human-readable summary string.
   */
  summary(): string {
    const total = this.results.length;
    const s = this.successes().length;
    const f = this.failures().length;
    const rate = (this.successRate() * 100).toFixed(1);
    return `${s}/${total} succeeded (${rate}%) - ${f} failure${f !== 1 ? "s" : ""}`;
  }

  /**
   * Serialisable snapshot of the collector state.
   */
  toJSON(): CollectorSummary {
    return {
      total: this.results.length,
      successCount: this.successes().length,
      failureCount: this.failures().length,
      successRate: this.successRate(),
      failures: this.failures().map((r) =>
        r.error instanceof Error ? r.error.message : String(r.error)
      ),
    };
  }

  /**
   * Reset all collected results.
   */
  clear(): this {
    this.results = [];
    return this;
  }
}
