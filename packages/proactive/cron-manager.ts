/**
 * CronManager - CLI wrapper for the daemon's cron WebSocket API.
 *
 * Connects to the Eight daemon gateway and exposes list, add, remove,
 * enable, and disable operations on cron jobs.
 */

import type { CronJob, JobType } from "../daemon/cron";

const DEFAULT_WS_URL = "ws://localhost:8741";
const CONNECT_TIMEOUT_MS = 5_000;

interface WsResponse {
  type: string;
  [key: string]: unknown;
}

async function rpc(url: string, message: Record<string, unknown>): Promise<WsResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS}ms - is the daemon running?`));
    }, CONNECT_TIMEOUT_MS);

    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(message));
    });

    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(String(event.data)) as WsResponse;
        resolve(data);
      } catch {
        reject(new Error("Invalid JSON from daemon"));
      } finally {
        ws.close();
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Cannot connect to daemon at ${url}`));
    });
  });
}

// ---- Public API ----

export async function listJobs(wsUrl = DEFAULT_WS_URL): Promise<CronJob[]> {
  const res = await rpc(wsUrl, { type: "cron:list" });
  if (res.type === "cron:list") return res.jobs as CronJob[];
  throw new Error(res.message ? String(res.message) : "Unexpected response");
}

export async function addCronJob(
  opts: { name: string; expression: string; jobType: JobType; payload: string; recurring?: boolean },
  wsUrl = DEFAULT_WS_URL,
): Promise<string> {
  const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job: CronJob = {
    id,
    name: opts.name,
    expression: opts.expression,
    type: opts.jobType,
    payload: opts.payload,
    enabled: true,
    lastRun: null,
    nextRun: null,
    recurring: opts.recurring ?? true,
  };
  const res = await rpc(wsUrl, { type: "cron:add", job });
  if (res.type === "cron:added") return res.jobId as string;
  throw new Error(res.message ? String(res.message) : "Failed to add job");
}

export async function removeCronJob(jobId: string, wsUrl = DEFAULT_WS_URL): Promise<boolean> {
  const res = await rpc(wsUrl, { type: "cron:remove", jobId });
  if (res.type === "cron:removed") return true;
  if (res.type === "error") throw new Error(String(res.message));
  return false;
}

export async function toggleJob(jobId: string, enabled: boolean, wsUrl = DEFAULT_WS_URL): Promise<void> {
  // The daemon doesn't have a dedicated toggle endpoint, so we read all jobs,
  // remove the target, then re-add it with the new enabled state.
  const jobs = await listJobs(wsUrl);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  await removeCronJob(jobId, wsUrl);
  const updated: CronJob = { ...job, enabled };
  const res = await rpc(wsUrl, { type: "cron:add", job: updated });
  if (res.type !== "cron:added") {
    throw new Error(res.message ? String(res.message) : "Failed to toggle job");
  }
}

export const enableJob = (jobId: string, wsUrl?: string) => toggleJob(jobId, true, wsUrl);
export const disableJob = (jobId: string, wsUrl?: string) => toggleJob(jobId, false, wsUrl);

// ---- CLI entry point ----

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const wsUrl = process.env.EIGHT_DAEMON_URL || DEFAULT_WS_URL;

  switch (command) {
    case "list": {
      const jobs = await listJobs(wsUrl);
      if (jobs.length === 0) {
        console.log("No cron jobs configured.");
        return;
      }
      console.log(`\n  ${"ID".padEnd(28)} ${"Name".padEnd(20)} ${"Schedule".padEnd(16)} ${"Type".padEnd(14)} Enabled`);
      console.log(`  ${"─".repeat(28)} ${"─".repeat(20)} ${"─".repeat(16)} ${"─".repeat(14)} ${"─".repeat(7)}`);
      for (const j of jobs) {
        const en = j.enabled ? "yes" : "no";
        console.log(`  ${j.id.padEnd(28)} ${j.name.padEnd(20)} ${j.expression.padEnd(16)} ${j.type.padEnd(14)} ${en}`);
      }
      console.log();
      break;
    }

    case "add": {
      const [name, expression, jobType, ...payloadParts] = args;
      if (!name || !expression || !jobType || payloadParts.length === 0) {
        console.error("Usage: cron-manager add <name> <expression> <shell|agent-prompt|webhook> <payload>");
        process.exit(1);
      }
      const id = await addCronJob({
        name,
        expression,
        jobType: jobType as JobType,
        payload: payloadParts.join(" "),
      }, wsUrl);
      console.log(`Added job: ${id}`);
      break;
    }

    case "remove": {
      const [jobId] = args;
      if (!jobId) { console.error("Usage: cron-manager remove <jobId>"); process.exit(1); }
      await removeCronJob(jobId, wsUrl);
      console.log(`Removed job: ${jobId}`);
      break;
    }

    case "enable": {
      const [jobId] = args;
      if (!jobId) { console.error("Usage: cron-manager enable <jobId>"); process.exit(1); }
      await enableJob(jobId, wsUrl);
      console.log(`Enabled job: ${jobId}`);
      break;
    }

    case "disable": {
      const [jobId] = args;
      if (!jobId) { console.error("Usage: cron-manager disable <jobId>"); process.exit(1); }
      await disableJob(jobId, wsUrl);
      console.log(`Disabled job: ${jobId}`);
      break;
    }

    default:
      console.log("Eight Cron Manager - manage daemon cron jobs\n");
      console.log("Commands:");
      console.log("  list                                          List all cron jobs");
      console.log("  add <name> <expr> <type> <payload>            Add a new job");
      console.log("  remove <jobId>                                Remove a job");
      console.log("  enable <jobId>                                Enable a job");
      console.log("  disable <jobId>                               Disable a job");
      console.log("\nEnvironment:");
      console.log("  EIGHT_DAEMON_URL   Daemon WebSocket URL (default: ws://localhost:8741)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
