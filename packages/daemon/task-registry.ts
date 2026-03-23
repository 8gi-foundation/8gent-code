/**
 * Task Registry - JSON-backed task store for CEO delegation tracking.
 *
 * Persists to ~/.8gent/tasks.json on the Fly volume.
 * Tracks delegated work through its lifecycle:
 * planned -> delegated -> in-progress -> review -> done | failed
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const TASKS_PATH = join(process.env.HOME || "/root", ".8gent", "tasks.json");
const MAX_TASKS = 100;

export type TaskStatus = "planned" | "delegated" | "in-progress" | "review" | "done" | "failed";
export type TaskPriority = "p0" | "p1" | "p2";

export interface CEOTask {
  id: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  githubIssue?: { number: number; url: string; repo: string };
  githubPR?: { number: number; url: string };
  subagentId?: string;
  plan?: string[];
  result?: string;
  repo?: string;
}

let tasks: CEOTask[] = [];
let loaded = false;

function ensureDir(): void {
  const dir = join(process.env.HOME || "/root", ".8gent");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): void {
  if (loaded) return;
  try {
    if (existsSync(TASKS_PATH)) {
      tasks = JSON.parse(readFileSync(TASKS_PATH, "utf-8"));
    }
  } catch {
    tasks = [];
  }
  loaded = true;
}

function save(): void {
  ensureDir();
  // Evict oldest if over limit
  if (tasks.length > MAX_TASKS) {
    tasks = tasks.slice(-MAX_TASKS);
  }
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
}

function generateId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createTask(description: string, priority: TaskPriority = "p1", repo?: string): CEOTask {
  load();
  const task: CEOTask = {
    id: generateId(),
    description,
    status: "planned",
    priority,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repo,
  };
  tasks.push(task);
  save();
  return task;
}

export function updateTask(id: string, updates: Partial<CEOTask>): CEOTask | null {
  load();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  save();
  return task;
}

export function getTask(id: string): CEOTask | null {
  load();
  return tasks.find((t) => t.id === id) || null;
}

export function listTasks(limit = 10): CEOTask[] {
  load();
  return [...tasks].reverse().slice(0, limit);
}

export function getTasksByStatus(status: TaskStatus): CEOTask[] {
  load();
  return tasks.filter((t) => t.status === status);
}

export function getActiveTasks(): CEOTask[] {
  load();
  return tasks.filter((t) => ["planned", "delegated", "in-progress"].includes(t.status));
}
