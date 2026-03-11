/**
 * 8gent Code - Task Management System
 *
 * Persistent task tracking with hierarchical relationships.
 * Tasks are stored in ~/.8gent/tasks.json and can be:
 * - Created manually with /task
 * - Auto-generated from PLAN output
 * - Updated with /task:done, /task:block, etc.
 *
 * Features:
 * - Hierarchical task organization (epics -> stories -> tasks)
 * - Dependency tracking (blockedBy)
 * - Status management (pending, in_progress, completed, blocked, cancelled)
 * - Owner assignment
 * - Priority levels
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

// ============================================
// Types
// ============================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  parentId?: string;
  subtasks: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dueDate?: string;
  estimatedMinutes?: number;
  actualMinutes?: number;
  notes: string[];
  metadata: Record<string, unknown>;
}

export interface TaskStore {
  version: string;
  lastUpdated: string;
  tasks: Task[];
  archivedTasks: Task[];
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  owner?: string;
  tags?: string[];
  parentId?: string | null;
  blockedBy?: string;
  hasSubtasks?: boolean;
}

export interface TaskUpdate {
  subject?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  owner?: string;
  dueDate?: string;
  estimatedMinutes?: number;
  actualMinutes?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ============================================
// Task Manager
// ============================================

export class TaskManager extends EventEmitter {
  private store: TaskStore;
  private storePath: string;
  private idCounter: number = 0;
  private autoSave: boolean = true;

  constructor(storePath?: string) {
    super();
    this.storePath = storePath || path.join(os.homedir(), ".8gent", "tasks.json");
    this.store = this.loadStore();
  }

  /**
   * Load task store from disk
   */
  private loadStore(): TaskStore {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.storePath)) {
      try {
        const data = fs.readFileSync(this.storePath, "utf-8");
        const store = JSON.parse(data) as TaskStore;

        // Find highest ID for counter
        for (const task of [...store.tasks, ...store.archivedTasks]) {
          const match = task.id.match(/^task-(\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > this.idCounter) {
              this.idCounter = num;
            }
          }
        }

        return store;
      } catch (err) {
        console.warn(`[tasks] Failed to load store, creating new: ${err}`);
      }
    }

    return {
      version: "1.0.0",
      lastUpdated: new Date().toISOString(),
      tasks: [],
      archivedTasks: [],
    };
  }

  /**
   * Save task store to disk
   */
  private saveStore(): void {
    this.store.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
  }

  /**
   * Generate a unique task ID
   */
  private generateId(): string {
    this.idCounter++;
    return `task-${this.idCounter}`;
  }

  /**
   * Create a new task
   */
  createTask(
    subject: string,
    description: string = "",
    options?: {
      priority?: TaskPriority;
      owner?: string;
      parentId?: string;
      tags?: string[];
      dueDate?: string;
      estimatedMinutes?: number;
      metadata?: Record<string, unknown>;
    }
  ): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: this.generateId(),
      subject,
      description,
      status: "pending",
      priority: options?.priority || "medium",
      owner: options?.owner,
      blockedBy: [],
      blocks: [],
      parentId: options?.parentId,
      subtasks: [],
      tags: options?.tags || [],
      createdAt: now,
      updatedAt: now,
      dueDate: options?.dueDate,
      estimatedMinutes: options?.estimatedMinutes,
      notes: [],
      metadata: options?.metadata || {},
    };

    // Add to parent's subtasks if applicable
    if (options?.parentId) {
      const parent = this.getTask(options.parentId);
      if (parent) {
        parent.subtasks.push(task.id);
        parent.updatedAt = now;
      }
    }

    this.store.tasks.push(task);

    if (this.autoSave) {
      this.saveStore();
    }

    this.emit("task:created", task);
    return task;
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): Task | undefined {
    return this.store.tasks.find(t => t.id === id);
  }

  /**
   * Update a task
   */
  updateTask(id: string, updates: TaskUpdate): Task | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;

    const now = new Date().toISOString();

    // Apply updates
    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.dueDate !== undefined) task.dueDate = updates.dueDate;
    if (updates.estimatedMinutes !== undefined) task.estimatedMinutes = updates.estimatedMinutes;
    if (updates.actualMinutes !== undefined) task.actualMinutes = updates.actualMinutes;
    if (updates.tags !== undefined) task.tags = updates.tags;
    if (updates.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...updates.metadata };
    }

    // Handle status changes
    if (updates.status !== undefined) {
      const oldStatus = task.status;
      task.status = updates.status;

      if (updates.status === "completed" && oldStatus !== "completed") {
        task.completedAt = now;
        this.emit("task:completed", task);
      } else if (oldStatus === "completed" && updates.status !== "completed") {
        task.completedAt = undefined;
      }

      // Unblock tasks that were blocked by this one
      if (updates.status === "completed") {
        this.unblockDependents(id);
      }
    }

    task.updatedAt = now;

    if (this.autoSave) {
      this.saveStore();
    }

    this.emit("task:updated", task);
    return task;
  }

  /**
   * Mark a task as done
   */
  completeTask(id: string, actualMinutes?: number): Task | undefined {
    return this.updateTask(id, {
      status: "completed",
      actualMinutes,
    });
  }

  /**
   * Start working on a task
   */
  startTask(id: string): Task | undefined {
    return this.updateTask(id, { status: "in_progress" });
  }

  /**
   * Block a task
   */
  blockTask(id: string, blockedById: string): Task | undefined {
    const task = this.getTask(id);
    const blocker = this.getTask(blockedById);

    if (!task || !blocker) return undefined;

    if (!task.blockedBy.includes(blockedById)) {
      task.blockedBy.push(blockedById);
      task.status = "blocked";
      task.updatedAt = new Date().toISOString();
    }

    if (!blocker.blocks.includes(id)) {
      blocker.blocks.push(id);
      blocker.updatedAt = new Date().toISOString();
    }

    if (this.autoSave) {
      this.saveStore();
    }

    this.emit("task:blocked", task, blocker);
    return task;
  }

  /**
   * Unblock dependents when a task is completed
   */
  private unblockDependents(completedId: string): void {
    for (const task of this.store.tasks) {
      const index = task.blockedBy.indexOf(completedId);
      if (index !== -1) {
        task.blockedBy.splice(index, 1);

        // If no more blockers, set back to pending
        if (task.blockedBy.length === 0 && task.status === "blocked") {
          task.status = "pending";
        }

        task.updatedAt = new Date().toISOString();
        this.emit("task:unblocked", task);
      }
    }
  }

  /**
   * Delete a task
   */
  deleteTask(id: string, archive: boolean = true): boolean {
    const index = this.store.tasks.findIndex(t => t.id === id);
    if (index === -1) return false;

    const task = this.store.tasks.splice(index, 1)[0];

    // Remove from parent's subtasks
    if (task.parentId) {
      const parent = this.getTask(task.parentId);
      if (parent) {
        const subtaskIndex = parent.subtasks.indexOf(id);
        if (subtaskIndex !== -1) {
          parent.subtasks.splice(subtaskIndex, 1);
        }
      }
    }

    // Archive or permanently delete
    if (archive) {
      this.store.archivedTasks.push(task);
    }

    // Remove from blockedBy lists
    for (const t of this.store.tasks) {
      const blockerIndex = t.blockedBy.indexOf(id);
      if (blockerIndex !== -1) {
        t.blockedBy.splice(blockerIndex, 1);
        if (t.blockedBy.length === 0 && t.status === "blocked") {
          t.status = "pending";
        }
      }

      const blocksIndex = t.blocks.indexOf(id);
      if (blocksIndex !== -1) {
        t.blocks.splice(blocksIndex, 1);
      }
    }

    if (this.autoSave) {
      this.saveStore();
    }

    this.emit("task:deleted", task);
    return true;
  }

  /**
   * List tasks with optional filtering
   */
  listTasks(filter?: TaskFilter): Task[] {
    let tasks = [...this.store.tasks];

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        tasks = tasks.filter(t => statuses.includes(t.status));
      }

      if (filter.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
        tasks = tasks.filter(t => priorities.includes(t.priority));
      }

      if (filter.owner !== undefined) {
        tasks = tasks.filter(t => t.owner === filter.owner);
      }

      if (filter.tags && filter.tags.length > 0) {
        tasks = tasks.filter(t =>
          filter.tags!.some(tag => t.tags.includes(tag))
        );
      }

      if (filter.parentId !== undefined) {
        tasks = tasks.filter(t => t.parentId === filter.parentId);
      }

      if (filter.blockedBy) {
        tasks = tasks.filter(t => t.blockedBy.includes(filter.blockedBy!));
      }

      if (filter.hasSubtasks !== undefined) {
        tasks = tasks.filter(t =>
          filter.hasSubtasks ? t.subtasks.length > 0 : t.subtasks.length === 0
        );
      }
    }

    return tasks;
  }

  /**
   * Search tasks by subject/description
   */
  searchTasks(query: string): Task[] {
    const queryLower = query.toLowerCase();
    return this.store.tasks.filter(
      t =>
        t.subject.toLowerCase().includes(queryLower) ||
        t.description.toLowerCase().includes(queryLower) ||
        t.tags.some(tag => tag.toLowerCase().includes(queryLower))
    );
  }

  /**
   * Get top-level tasks (no parent)
   */
  getTopLevelTasks(): Task[] {
    return this.store.tasks.filter(t => !t.parentId);
  }

  /**
   * Get subtasks of a task
   */
  getSubtasks(parentId: string): Task[] {
    return this.store.tasks.filter(t => t.parentId === parentId);
  }

  /**
   * Add a note to a task
   */
  addNote(id: string, note: string): Task | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;

    task.notes.push(`[${new Date().toISOString()}] ${note}`);
    task.updatedAt = new Date().toISOString();

    if (this.autoSave) {
      this.saveStore();
    }

    return task;
  }

  /**
   * Add tag to a task
   */
  addTag(id: string, tag: string): Task | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;

    if (!task.tags.includes(tag)) {
      task.tags.push(tag);
      task.updatedAt = new Date().toISOString();

      if (this.autoSave) {
        this.saveStore();
      }
    }

    return task;
  }

  /**
   * Parse tasks from PLAN output
   * e.g., "PLAN: 1) scaffold project 2) create landing page 3) commit"
   */
  parseFromPlan(planOutput: string, parentSubject?: string): Task[] {
    const created: Task[] = [];
    const planMatch = planOutput.match(/PLAN:\s*(.+)/i);

    if (!planMatch) return created;

    const planContent = planMatch[1];

    // Parse numbered steps: "1) step one 2) step two" or "1. step one 2. step two"
    const stepRegex = /(\d+)[.)]\s*([^0-9]+?)(?=\d+[.)]|$)/g;
    let match;
    let parentId: string | undefined;

    // Create parent task if subject provided
    if (parentSubject) {
      const parent = this.createTask(parentSubject, planOutput, {
        tags: ["plan"],
      });
      parentId = parent.id;
      created.push(parent);
    }

    while ((match = stepRegex.exec(planContent)) !== null) {
      const stepNum = parseInt(match[1], 10);
      const stepDesc = match[2].trim();

      if (stepDesc) {
        const task = this.createTask(stepDesc, "", {
          parentId,
          metadata: { stepNumber: stepNum },
          tags: ["auto-generated"],
        });
        created.push(task);
      }
    }

    return created;
  }

  /**
   * Get task statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
    cancelled: number;
    archived: number;
    byPriority: Record<TaskPriority, number>;
  } {
    const tasks = this.store.tasks;

    const byPriority: Record<TaskPriority, number> = {
      low: 0,
      medium: 0,
      high: 0,
      urgent: 0,
    };

    for (const task of tasks) {
      byPriority[task.priority]++;
    }

    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === "pending").length,
      inProgress: tasks.filter(t => t.status === "in_progress").length,
      completed: tasks.filter(t => t.status === "completed").length,
      blocked: tasks.filter(t => t.status === "blocked").length,
      cancelled: tasks.filter(t => t.status === "cancelled").length,
      archived: this.store.archivedTasks.length,
      byPriority,
    };
  }

  /**
   * Archive completed tasks older than days
   */
  archiveOld(olderThanDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffStr = cutoff.toISOString();

    let archived = 0;
    const remaining: Task[] = [];

    for (const task of this.store.tasks) {
      if (
        task.status === "completed" &&
        task.completedAt &&
        task.completedAt < cutoffStr
      ) {
        this.store.archivedTasks.push(task);
        archived++;
      } else {
        remaining.push(task);
      }
    }

    this.store.tasks = remaining;

    if (archived > 0 && this.autoSave) {
      this.saveStore();
    }

    return archived;
  }

  /**
   * Clear all completed tasks
   */
  clearCompleted(): number {
    const before = this.store.tasks.length;
    this.store.tasks = this.store.tasks.filter(t => t.status !== "completed");
    const cleared = before - this.store.tasks.length;

    if (cleared > 0 && this.autoSave) {
      this.saveStore();
    }

    return cleared;
  }

  /**
   * Get store path
   */
  getStorePath(): string {
    return this.storePath;
  }

  /**
   * Set auto-save mode
   */
  setAutoSave(enabled: boolean): void {
    this.autoSave = enabled;
  }

  /**
   * Force save
   */
  save(): void {
    this.saveStore();
  }

  /**
   * Reload from disk
   */
  reload(): void {
    this.store = this.loadStore();
  }
}

// ============================================
// Singleton Instance
// ============================================

let taskManagerInstance: TaskManager | null = null;

export function getTaskManager(storePath?: string): TaskManager {
  if (!taskManagerInstance) {
    taskManagerInstance = new TaskManager(storePath);
  }
  return taskManagerInstance;
}

export function resetTaskManager(): void {
  taskManagerInstance = null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format task for display
 */
export function formatTask(task: Task, verbose: boolean = false): string {
  const statusIcons: Record<TaskStatus, string> = {
    pending: "\u25cb",    // Circle
    in_progress: "\u25d4", // Half circle
    completed: "\u2713",  // Checkmark
    blocked: "\u2718",    // X
    cancelled: "\u2212",  // Minus
  };

  const priorityColors: Record<TaskPriority, string> = {
    low: "\x1b[90m",     // Gray
    medium: "\x1b[0m",   // Normal
    high: "\x1b[33m",    // Yellow
    urgent: "\x1b[31m",  // Red
  };

  const statusColor: Record<TaskStatus, string> = {
    pending: "\x1b[37m",
    in_progress: "\x1b[36m",
    completed: "\x1b[32m",
    blocked: "\x1b[31m",
    cancelled: "\x1b[90m",
  };

  const reset = "\x1b[0m";
  const icon = statusIcons[task.status];
  const pColor = priorityColors[task.priority];
  const sColor = statusColor[task.status];

  let output = `${sColor}${icon}${reset} ${pColor}[${task.id}]${reset} ${task.subject}`;

  if (verbose) {
    output += `\n   Status: ${task.status} | Priority: ${task.priority}`;
    if (task.owner) output += ` | Owner: ${task.owner}`;
    if (task.tags.length > 0) output += `\n   Tags: ${task.tags.join(", ")}`;
    if (task.description) output += `\n   ${task.description}`;
    if (task.blockedBy.length > 0) output += `\n   Blocked by: ${task.blockedBy.join(", ")}`;
  }

  return output;
}

/**
 * Parse /task command
 * Examples:
 * - /task "fix login bug"
 * - /task "implement auth" --priority high --tag backend
 * - /task:done task-1
 * - /task:start task-2
 */
export function parseTaskCommand(input: string): {
  action: "create" | "list" | "done" | "start" | "delete" | "show" | "block";
  subject?: string;
  taskId?: string;
  options: {
    priority?: TaskPriority;
    tags?: string[];
    owner?: string;
    blockedBy?: string;
    verbose?: boolean;
  };
} | null {
  if (!input.startsWith("/task")) return null;

  const options: {
    priority?: TaskPriority;
    tags?: string[];
    owner?: string;
    blockedBy?: string;
    verbose?: boolean;
  } = {};

  // Handle action variants
  if (input.startsWith("/tasks")) {
    // Check for verbose flag
    options.verbose = input.includes("-v") || input.includes("--verbose");
    return { action: "list", options };
  }

  if (input.startsWith("/task:done ")) {
    const taskId = input.slice(11).trim();
    return { action: "done", taskId, options };
  }

  if (input.startsWith("/task:start ")) {
    const taskId = input.slice(12).trim();
    return { action: "start", taskId, options };
  }

  if (input.startsWith("/task:delete ")) {
    const taskId = input.slice(13).trim();
    return { action: "delete", taskId, options };
  }

  if (input.startsWith("/task:show ")) {
    const taskId = input.slice(11).trim();
    return { action: "show", taskId, options };
  }

  if (input.startsWith("/task:block ")) {
    const parts = input.slice(12).trim().split(/\s+/);
    if (parts.length >= 2) {
      return { action: "block", taskId: parts[0], options: { blockedBy: parts[1] } };
    }
    return null;
  }

  // Create task: /task "description" [--priority high] [--tag tag1]
  if (input.startsWith("/task ")) {
    const rest = input.slice(6).trim();

    // Extract quoted subject
    const subjectMatch = rest.match(/^["'](.+?)["']/);
    let subject = "";
    let remaining = rest;

    if (subjectMatch) {
      subject = subjectMatch[1];
      remaining = rest.slice(subjectMatch[0].length).trim();
    } else {
      // No quotes, take first word or everything before --
      const dashIndex = rest.indexOf("--");
      if (dashIndex !== -1) {
        subject = rest.slice(0, dashIndex).trim();
        remaining = rest.slice(dashIndex);
      } else {
        subject = rest;
        remaining = "";
      }
    }

    // Parse options
    const priorityMatch = remaining.match(/--priority\s+(\w+)/);
    if (priorityMatch) {
      const p = priorityMatch[1].toLowerCase();
      if (["low", "medium", "high", "urgent"].includes(p)) {
        options.priority = p as TaskPriority;
      }
    }

    const tagMatches = remaining.matchAll(/--tag\s+(\w+)/g);
    const tags: string[] = [];
    for (const m of tagMatches) {
      tags.push(m[1]);
    }
    if (tags.length > 0) {
      options.tags = tags;
    }

    const ownerMatch = remaining.match(/--owner\s+(\w+)/);
    if (ownerMatch) {
      options.owner = ownerMatch[1];
    }

    return { action: "create", subject, options };
  }

  return null;
}
