/**
 * Heartbeat - Proactive wake system.
 *
 * Runs on a configurable interval (default 30 min). Performs cheap
 * deterministic checks first, only escalating to LLM evaluation
 * when something actually needs attention.
 */

import { bus } from "./events";
import { getNextDueJob } from "./cron";

export interface HeartbeatConfig {
  intervalMs: number; // default 30 * 60 * 1000
  taskQueuePath: string; // path to pending tasks file
  enabled: boolean;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  intervalMs: 30 * 60 * 1000,
  taskQueuePath: `${process.env.HOME}/.8gent/task-queue.json`,
  enabled: true,
};

export interface HeartbeatResult {
  timestamp: string;
  checks: {
    pendingTasks: number;
    dueCronJobs: number;
    unreadMessages: number;
    actionTriggered: boolean;
  };
}

async function checkTaskQueue(path: string): Promise<number> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return 0;
    const data = await file.json();
    return Array.isArray(data) ? data.filter((t: any) => t.status === "pending").length : 0;
  } catch {
    return 0;
  }
}

async function checkUnreadMessages(): Promise<number> {
  // Check for unread messages across channels
  const inboxPath = `${process.env.HOME}/.8gent/inbox.json`;
  try {
    const file = Bun.file(inboxPath);
    if (!(await file.exists())) return 0;
    const msgs = await file.json();
    return Array.isArray(msgs) ? msgs.filter((m: any) => !m.read).length : 0;
  } catch {
    return 0;
  }
}

async function runHeartbeat(config: HeartbeatConfig): Promise<HeartbeatResult> {
  const pendingTasks = await checkTaskQueue(config.taskQueuePath);
  const nextCron = getNextDueJob();
  const dueCronJobs = nextCron ? 1 : 0;
  const unreadMessages = await checkUnreadMessages();

  const actionTriggered = pendingTasks > 0 || dueCronJobs > 0 || unreadMessages > 0;

  const result: HeartbeatResult = {
    timestamp: new Date().toISOString(),
    checks: { pendingTasks, dueCronJobs, unreadMessages, actionTriggered },
  };

  if (actionTriggered) {
    bus.emit("agent:thinking", { sessionId: "heartbeat" });
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(config: Partial<HeartbeatConfig> = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return;

  // Run immediately on start
  runHeartbeat(cfg).catch((err) => console.error("[heartbeat] error:", err));

  timer = setInterval(() => {
    runHeartbeat(cfg).catch((err) => console.error("[heartbeat] error:", err));
  }, cfg.intervalMs);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
