/**
 * Cron - Job scheduler for the daemon.
 *
 * Supports cron expressions, one-shot and recurring jobs,
 * persistence to ~/.8gent/cron.json, and restart catchup.
 */

import { bus } from "./events";

export type JobType = "shell" | "agent-prompt" | "webhook";

export interface CronJob {
  id: string;
  name: string;
  expression: string; // cron expression: "*/30 * * * *" or "once:ISO8601"
  type: JobType;
  payload: string; // shell command, prompt text, or webhook URL
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  recurring: boolean;
}

const CRON_PATH = `${process.env.HOME}/.8gent/cron.json`;
let jobs: CronJob[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;

export async function loadJobs(): Promise<CronJob[]> {
  try {
    const file = Bun.file(CRON_PATH);
    if (!(await file.exists())) return [];
    jobs = await file.json();
    return jobs;
  } catch {
    jobs = [];
    return jobs;
  }
}

async function saveJobs(): Promise<void> {
  await Bun.write(CRON_PATH, JSON.stringify(jobs, null, 2));
}

/** Parse a simple cron expression and check if it matches the current minute */
function matchesCron(expr: string, now: Date): boolean {
  if (expr.startsWith("once:")) {
    const target = new Date(expr.slice(5));
    return Math.abs(now.getTime() - target.getTime()) < 60_000;
  }

  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];

  return parts.every((part, i) => {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      return fields[i] % step === 0;
    }
    const vals = part.split(",").map(Number);
    return vals.includes(fields[i]);
  });
}

async function executeJob(job: CronJob): Promise<void> {
  console.log(`[cron] executing job: ${job.name} (${job.type})`);
  bus.emit("tool:start", { sessionId: "cron", tool: `cron:${job.type}`, input: job.payload });

  const startMs = Date.now();
  try {
    let output: unknown;
    if (job.type === "shell") {
      const proc = Bun.spawn(["sh", "-c", job.payload], { stdout: "pipe", stderr: "pipe" });
      output = await new Response(proc.stdout).text();
    } else if (job.type === "webhook") {
      const res = await fetch(job.payload, { method: "POST" });
      output = { status: res.status };
    } else {
      // agent-prompt: emit an event for the agent loop to pick up
      output = { prompt: job.payload, queued: true };
    }

    bus.emit("tool:result", {
      sessionId: "cron",
      tool: `cron:${job.type}`,
      output,
      durationMs: Date.now() - startMs,
    });
  } catch (err) {
    bus.emit("agent:error", { sessionId: "cron", error: String(err) });
  }

  job.lastRun = new Date().toISOString();
  if (!job.recurring) job.enabled = false;
  await saveJobs();
}

function tick(): void {
  const now = new Date();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (matchesCron(job.expression, now)) {
      executeJob(job).catch((err) => console.error("[cron] tick error:", err));
    }
  }
}

/** Check for missed jobs since last run and execute them */
async function catchup(): Promise<void> {
  const now = new Date();
  for (const job of jobs) {
    if (!job.enabled || !job.lastRun) continue;
    const lastRun = new Date(job.lastRun);
    const gapMinutes = (now.getTime() - lastRun.getTime()) / 60_000;
    // If more than 2 intervals were missed, run once to catch up
    if (job.expression.startsWith("*/")) {
      const step = parseInt(job.expression.split("*/")[1], 10);
      if (gapMinutes > step * 2) {
        console.log(`[cron] catchup: running missed job ${job.name}`);
        await executeJob(job);
      }
    }
  }
}

export async function startCron(): Promise<void> {
  await loadJobs();
  await catchup();
  // Tick every 60 seconds
  tickTimer = setInterval(tick, 60_000);
}

export function stopCron(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export function addJob(job: CronJob): void {
  jobs.push(job);
  saveJobs().catch(console.error);
}

export function removeJob(id: string): boolean {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  saveJobs().catch(console.error);
  return true;
}

export function getJobs(): CronJob[] {
  return [...jobs];
}

/** Return the next job that is due (used by heartbeat) */
export function getNextDueJob(): CronJob | null {
  const now = new Date();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (matchesCron(job.expression, now)) return job;
  }
  return null;
}
