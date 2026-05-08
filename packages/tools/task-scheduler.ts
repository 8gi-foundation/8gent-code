/**
 * Task Scheduler - time-based job scheduler for agent automation.
 * Supports one-shot and recurring jobs with pause, resume, and cancel.
 */

export type JobId = string;

export type JobStatus = "active" | "paused" | "cancelled" | "done";

export interface Job {
  id: JobId;
  fn: () => void | Promise<void>;
  interval: number | null; // null = one-shot
  delay: number;
  status: JobStatus;
  nextRunAt: number;
  runCount: number;
  createdAt: number;
}

export interface JobSummary {
  id: JobId;
  type: "one-shot" | "recurring";
  status: JobStatus;
  interval: number | null;
  nextRunAt: number | null;
  runCount: number;
  createdAt: number;
}

let _idCounter = 0;
function nextId(): JobId {
  return `job-${Date.now()}-${++_idCounter}`;
}

export class Scheduler {
  private jobs: Map<JobId, Job> = new Map();
  private timers: Map<JobId, ReturnType<typeof setTimeout>> = new Map();

  scheduleOnce(fn: () => void | Promise<void>, delayMs: number): JobId {
    const id = nextId();
    const now = Date.now();
    const job: Job = {
      id,
      fn,
      interval: null,
      delay: delayMs,
      status: "active",
      nextRunAt: now + delayMs,
      runCount: 0,
      createdAt: now,
    };
    this.jobs.set(id, job);
    const timer = setTimeout(async () => {
      const j = this.jobs.get(id);
      if (!j || j.status !== "active") return;
      j.runCount++;
      j.status = "done";
      this.timers.delete(id);
      await j.fn();
    }, delayMs);
    this.timers.set(id, timer);
    return id;
  }

  scheduleRecurring(fn: () => void | Promise<void>, intervalMs: number): JobId {
    const id = nextId();
    const now = Date.now();
    const job: Job = {
      id,
      fn,
      interval: intervalMs,
      delay: intervalMs,
      status: "active",
      nextRunAt: now + intervalMs,
      runCount: 0,
      createdAt: now,
    };
    this.jobs.set(id, job);
    this._armRecurring(id);
    return id;
  }

  private _armRecurring(id: JobId): void {
    const job = this.jobs.get(id);
    if (!job || job.interval === null || job.status !== "active") return;
    const timer = setTimeout(async () => {
      const j = this.jobs.get(id);
      if (!j || j.status !== "active") return;
      j.runCount++;
      j.nextRunAt = Date.now() + j.interval!;
      this.timers.delete(id);
      await j.fn();
      this._armRecurring(id);
    }, job.interval);
    this.timers.set(id, timer);
  }

  cancel(id: JobId): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.status = "cancelled";
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    return true;
  }

  pause(id: JobId): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "active") return false;
    job.status = "paused";
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    return true;
  }

  resume(id: JobId): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "paused") return false;
    job.status = "active";
    const remaining = Math.max(0, job.nextRunAt - Date.now());
    if (job.interval === null) {
      // one-shot: re-arm with remaining time
      const timer = setTimeout(async () => {
        const j = this.jobs.get(id);
        if (!j || j.status !== "active") return;
        j.runCount++;
        j.status = "done";
        this.timers.delete(id);
        await j.fn();
      }, remaining);
      this.timers.set(id, timer);
    } else {
      job.nextRunAt = Date.now() + remaining;
      this._armRecurring(id);
    }
    return true;
  }

  listJobs(): JobSummary[] {
    return Array.from(this.jobs.values()).map((j) => ({
      id: j.id,
      type: j.interval === null ? "one-shot" : "recurring",
      status: j.status,
      interval: j.interval,
      nextRunAt: j.status === "active" ? j.nextRunAt : null,
      runCount: j.runCount,
      createdAt: j.createdAt,
    }));
  }

  clear(): void {
    for (const id of this.jobs.keys()) {
      this.cancel(id);
    }
    this.jobs.clear();
  }
}
