/**
 * scheduler-cron-v2 - Improved cron scheduler with timezone and overlap protection.
 */

export interface CronOptions {
  timezone?: string;
  noOverlap?: boolean;
  maxRuns?: number;
  onError?: (err: unknown) => void;
}

type CronFn = () => Promise<void> | void;

function nextFireDate(expr: string, after: Date, tz: string): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: "${expr}"`);
  const [minF, hourF, domF, monthF, dowF] = fields;

  function matches(field: string, value: number): boolean {
    if (field === "*") return true;
    if (field.startsWith("*/")) return value % parseInt(field.slice(2), 10) === 0;
    if (field.includes(",")) return field.split(",").some((p) => matches(p, value));
    if (field.includes("-")) {
      const [lo, hi] = field.split("-").map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field, 10) === value;
  }

  const candidate = new Date(after.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 527_040; i++) {
    const local = new Date(candidate.toLocaleString("en-US", { timeZone: tz }));
    if (
      matches(monthF, local.getMonth() + 1) &&
      matches(domF, local.getDate()) &&
      matches(dowF, local.getDay()) &&
      matches(hourF, local.getHours()) &&
      matches(minF, local.getMinutes())
    ) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }
  throw new Error(`No next fire date found within 366 days for: "${expr}"`);
}

export class CronJob {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private runCount = 0;
  private stopped = false;

  readonly id: string;
  readonly expr: string;
  private readonly fn: CronFn;
  private readonly opts: Required<CronOptions>;

  constructor(id: string, expr: string, fn: CronFn, opts: CronOptions = {}) {
    this.id = id;
    this.expr = expr;
    this.fn = fn;
    this.opts = {
      timezone: opts.timezone ?? "UTC",
      noOverlap: opts.noOverlap ?? false,
      maxRuns: opts.maxRuns ?? Infinity,
      onError: opts.onError ?? ((err) => console.error(`[CronJob:${this.id}] error:`, err)),
    };
  }

  start(): this {
    if (this.stopped) throw new Error(`CronJob "${this.id}" has been stopped.`);
    this.schedule();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  get isRunning(): boolean { return this.running; }
  get totalRuns(): number { return this.runCount; }

  private schedule(): void {
    if (this.stopped) return;
    const now = new Date();
    const next = nextFireDate(this.expr, now, this.opts.timezone);
    this.timer = setTimeout(async () => {
      await this.tick();
      if (!this.stopped) this.schedule();
    }, next.getTime() - now.getTime());
  }

  private async tick(): Promise<void> {
    if (this.opts.noOverlap && this.running) return;
    if (this.runCount >= this.opts.maxRuns) { this.stop(); return; }
    this.running = true;
    try {
      await this.fn();
      this.runCount++;
      if (this.runCount >= this.opts.maxRuns) this.stop();
    } catch (err) {
      this.opts.onError(err);
    } finally {
      this.running = false;
    }
  }
}

export class CronManager {
  private jobs = new Map<string, CronJob>();

  add(id: string, expr: string, fn: CronFn, opts?: CronOptions): CronJob {
    if (this.jobs.has(id)) throw new Error(`CronJob "${id}" already registered.`);
    const job = new CronJob(id, expr, fn, opts).start();
    this.jobs.set(id, job);
    return job;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.stop();
    this.jobs.delete(id);
    return true;
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  status(): Array<{ id: string; totalRuns: number; isRunning: boolean }> {
    return Array.from(this.jobs.values()).map((j) => ({
      id: j.id,
      totalRuns: j.totalRuns,
      isRunning: j.isRunning,
    }));
  }
}
