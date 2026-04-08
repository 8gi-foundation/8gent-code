/**
 * Composable health check system for agent services.
 * Register named checks, run all with per-check timeouts,
 * aggregate to healthy/degraded/unhealthy, expose as HTTP endpoint data.
 */

export type CheckStatus = "healthy" | "degraded" | "unhealthy";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message?: string;
  durationMs: number;
  checkedAt: string;
}

export interface AggregatedHealth {
  status: CheckStatus;
  checks: CheckResult[];
  durationMs: number;
  checkedAt: string;
}

export type CheckFn = () => Promise<{ status: CheckStatus; message?: string }>;

interface RegisteredCheck {
  name: string;
  fn: CheckFn;
  timeoutMs: number;
  tags: string[];
}

export class HealthChecker {
  private checks: Map<string, RegisteredCheck> = new Map();
  private defaultTimeoutMs: number;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
  }

  /** Register a named health check. */
  register(
    name: string,
    fn: CheckFn,
    options: { timeoutMs?: number; tags?: string[] } = {}
  ): this {
    this.checks.set(name, {
      name,
      fn,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      tags: options.tags ?? [],
    });
    return this;
  }

  /** Remove a registered check by name. */
  deregister(name: string): this {
    this.checks.delete(name);
    return this;
  }

  /** Run a single check with timeout enforcement. */
  private async runOne(check: RegisteredCheck): Promise<CheckResult> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();

    const timeout = new Promise<{ status: CheckStatus; message: string }>(
      (resolve) =>
        setTimeout(
          () =>
            resolve({
              status: "unhealthy",
              message: `Timed out after ${check.timeoutMs}ms`,
            }),
          check.timeoutMs
        )
    );

    try {
      const result = await Promise.race([check.fn(), timeout]);
      return {
        name: check.name,
        status: result.status,
        message: result.message,
        durationMs: Date.now() - start,
        checkedAt,
      };
    } catch (err) {
      return {
        name: check.name,
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        checkedAt,
      };
    }
  }

  /**
   * Run all registered checks (or a filtered subset by tag).
   * Aggregation: all healthy -> healthy, any unhealthy -> unhealthy, otherwise degraded.
   */
  async run(options: { tags?: string[] } = {}): Promise<AggregatedHealth> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();

    const candidates = [...this.checks.values()].filter(
      (c) =>
        !options.tags ||
        options.tags.length === 0 ||
        c.tags.some((t) => options.tags!.includes(t))
    );

    const results = await Promise.all(candidates.map((c) => this.runOne(c)));

    const anyUnhealthy = results.some((r) => r.status === "unhealthy");
    const anyDegraded = results.some((r) => r.status === "degraded");
    const status: CheckStatus = anyUnhealthy
      ? "unhealthy"
      : anyDegraded
      ? "degraded"
      : "healthy";

    return { status, checks: results, durationMs: Date.now() - start, checkedAt };
  }

  /**
   * Serialize to HTTP endpoint format (JSON-ready).
   * Mirrors the shape of popular health check standards (e.g. kubernetes probe, health-checks.io).
   */
  async toHttpPayload(options: { tags?: string[] } = {}): Promise<{
    status: CheckStatus;
    http_status: 200 | 207 | 503;
    checks: CheckResult[];
    durationMs: number;
    checkedAt: string;
  }> {
    const health = await this.run(options);
    const http_status =
      health.status === "healthy" ? 200 : health.status === "degraded" ? 207 : 503;
    return { ...health, http_status };
  }
}

/** Convenience: build a dependency check that pings a URL (fetch-based). */
export function httpDependency(
  url: string,
  options: { expectedStatus?: number } = {}
): CheckFn {
  const expectedStatus = options.expectedStatus ?? 200;
  return async () => {
    const res = await fetch(url);
    if (res.status === expectedStatus) return { status: "healthy" };
    return {
      status: "unhealthy",
      message: `Expected HTTP ${expectedStatus}, got ${res.status}`,
    };
  };
}
