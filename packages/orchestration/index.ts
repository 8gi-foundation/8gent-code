/**
 * 8gent Code - Multi-Agent Orchestration
 *
 * Enables spawning multiple agents to work in parallel on complex tasks.
 * Features:
 * - AgentPool: Manages multiple Agent instances
 * - TaskQueue: Distributes work across agents
 * - Message passing between agents via shared context
 * - Background agent execution with /spawn, /agents, /join commands
 */

import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

// ============================================
// Types
// ============================================

export type AgentStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface AgentTask {
  id: string;
  description: string;
  priority: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: AgentStatus;
  result?: unknown;
  error?: string;
  agentId?: string;
  parentTaskId?: string;
  subtasks?: string[];
}

export interface AgentConfig {
  id: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  workingDirectory: string;
  capabilities?: string[];
}

export interface SpawnedAgent {
  id: string;
  config: AgentConfig;
  task: AgentTask;
  status: AgentStatus;
  startedAt: Date;
  completedAt?: Date;
  messages: AgentMessage[];
  tokenCount: number;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string | "broadcast";
  type: "request" | "response" | "notification" | "result";
  content: unknown;
  timestamp: Date;
}

export interface SharedContext {
  key: string;
  value: unknown;
  setBy: string;
  timestamp: Date;
}

export interface QueuedTask extends AgentTask {
  dependencies: string[];
  retryCount: number;
  maxRetries: number;
}

// ============================================
// Agent Pool
// ============================================

export class AgentPool extends EventEmitter {
  private agents: Map<string, SpawnedAgent> = new Map();
  private sharedContext: Map<string, SharedContext> = new Map();
  private maxConcurrent: number;
  private runningCount: number = 0;
  private idCounter: number = 0;

  constructor(maxConcurrent: number = 4) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Spawn a new background agent with a task
   */
  async spawnAgent(
    taskDescription: string,
    config?: Partial<AgentConfig>
  ): Promise<SpawnedAgent> {
    const agentId = this.generateId("agent");
    const taskId = this.generateId("task");

    const agentConfig: AgentConfig = {
      id: agentId,
      model: config?.model || "glm-4.7-flash:latest",
      systemPrompt: config?.systemPrompt,
      maxTurns: config?.maxTurns || 20,
      workingDirectory: config?.workingDirectory || process.cwd(),
      capabilities: config?.capabilities || [],
    };

    const task: AgentTask = {
      id: taskId,
      description: taskDescription,
      priority: 1,
      createdAt: new Date(),
      status: "idle",
    };

    const spawnedAgent: SpawnedAgent = {
      id: agentId,
      config: agentConfig,
      task,
      status: "idle",
      startedAt: new Date(),
      messages: [],
      tokenCount: 0,
    };

    this.agents.set(agentId, spawnedAgent);

    // Start execution if under concurrency limit
    if (this.runningCount < this.maxConcurrent) {
      this.executeAgent(agentId);
    }

    this.emit("agent:spawned", spawnedAgent);
    return spawnedAgent;
  }

  /**
   * Execute an agent's task
   */
  private async executeAgent(agentId: string): Promise<void> {
    const spawnedAgent = this.agents.get(agentId);
    if (!spawnedAgent) return;

    spawnedAgent.status = "running";
    spawnedAgent.task.status = "running";
    spawnedAgent.task.startedAt = new Date();
    this.runningCount++;

    this.emit("agent:started", spawnedAgent);

    try {
      // Import the Agent class dynamically to avoid circular deps
      const { Agent } = await import("../eight");

      const agent = new Agent({
        model: spawnedAgent.config.model,
        runtime: "ollama",
        systemPrompt: spawnedAgent.config.systemPrompt,
        maxTurns: spawnedAgent.config.maxTurns,
        workingDirectory: spawnedAgent.config.workingDirectory,
      });

      // Check if Ollama is available
      if (!(await agent.isReady())) {
        throw new Error("Ollama is not running");
      }

      // Execute the task
      const result = await agent.chat(spawnedAgent.task.description);

      spawnedAgent.status = "completed";
      spawnedAgent.task.status = "completed";
      spawnedAgent.task.result = result;
      spawnedAgent.completedAt = new Date();
      spawnedAgent.task.completedAt = new Date();
      spawnedAgent.tokenCount = agent.getHistoryLength() * 100; // Rough estimate

      this.emit("agent:completed", spawnedAgent);
    } catch (err) {
      spawnedAgent.status = "failed";
      spawnedAgent.task.status = "failed";
      spawnedAgent.task.error = err instanceof Error ? err.message : String(err);
      spawnedAgent.completedAt = new Date();
      spawnedAgent.task.completedAt = new Date();

      this.emit("agent:failed", spawnedAgent);
    } finally {
      this.runningCount--;
      this.processQueue();
    }
  }

  /**
   * Process any queued agents
   */
  private processQueue(): void {
    for (const [agentId, agent] of this.agents) {
      if (agent.status === "idle" && this.runningCount < this.maxConcurrent) {
        this.executeAgent(agentId);
      }
    }
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): SpawnedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all agents
   */
  listAgents(): SpawnedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * List running agents
   */
  listRunningAgents(): SpawnedAgent[] {
    return this.listAgents().filter(a => a.status === "running");
  }

  /**
   * List completed agents
   */
  listCompletedAgents(): SpawnedAgent[] {
    return this.listAgents().filter(a => a.status === "completed");
  }

  /**
   * Wait for an agent to complete
   */
  async joinAgent(agentId: string, timeoutMs: number = 300000): Promise<SpawnedAgent> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (agent.status === "completed" || agent.status === "failed") {
      return agent;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for agent ${agentId}`));
      }, timeoutMs);

      const checkComplete = (completedAgent: SpawnedAgent) => {
        if (completedAgent.id === agentId) {
          clearTimeout(timeout);
          this.off("agent:completed", checkComplete);
          this.off("agent:failed", checkComplete);
          resolve(completedAgent);
        }
      };

      this.on("agent:completed", checkComplete);
      this.on("agent:failed", checkComplete);
    });
  }

  /**
   * Cancel an agent
   */
  cancelAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "running") return false;

    agent.status = "cancelled";
    agent.task.status = "cancelled";
    agent.completedAt = new Date();
    agent.task.completedAt = new Date();

    this.emit("agent:cancelled", agent);
    return true;
  }

  /**
   * Send a message to an agent
   */
  sendMessage(fromAgentId: string, toAgentId: string | "broadcast", content: unknown): void {
    const message: AgentMessage = {
      id: this.generateId("msg"),
      fromAgent: fromAgentId,
      toAgent: toAgentId,
      type: "notification",
      content,
      timestamp: new Date(),
    };

    if (toAgentId === "broadcast") {
      // Send to all agents
      for (const agent of this.agents.values()) {
        agent.messages.push(message);
      }
    } else {
      const targetAgent = this.agents.get(toAgentId);
      if (targetAgent) {
        targetAgent.messages.push(message);
      }
    }

    this.emit("message", message);
  }

  /**
   * Set shared context value
   */
  setContext(key: string, value: unknown, setBy: string): void {
    this.sharedContext.set(key, {
      key,
      value,
      setBy,
      timestamp: new Date(),
    });

    this.emit("context:updated", { key, value, setBy });
  }

  /**
   * Get shared context value
   */
  getContext(key: string): unknown {
    return this.sharedContext.get(key)?.value;
  }

  /**
   * Get all shared context
   */
  getAllContext(): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    for (const [key, ctx] of this.sharedContext) {
      context[key] = ctx.value;
    }
    return context;
  }

  /**
   * Clear shared context
   */
  clearContext(): void {
    this.sharedContext.clear();
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    this.idCounter++;
    return `${prefix}-${Date.now()}-${this.idCounter}`;
  }

  /**
   * Get pool stats
   */
  getStats(): {
    totalAgents: number;
    running: number;
    completed: number;
    failed: number;
    idle: number;
  } {
    const agents = this.listAgents();
    return {
      totalAgents: agents.length,
      running: agents.filter(a => a.status === "running").length,
      completed: agents.filter(a => a.status === "completed").length,
      failed: agents.filter(a => a.status === "failed").length,
      idle: agents.filter(a => a.status === "idle").length,
    };
  }

  /**
   * Clear completed/failed agents
   */
  clearFinished(): number {
    let cleared = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled") {
        this.agents.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Get maximum concurrent agents
   */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Set maximum concurrent agents
   */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
    this.processQueue();
  }
}

// ============================================
// Task Queue
// ============================================

export class TaskQueue extends EventEmitter {
  private queue: QueuedTask[] = [];
  private processing: Map<string, QueuedTask> = new Map();
  private completed: Map<string, QueuedTask> = new Map();
  private agentPool: AgentPool;
  private isProcessing: boolean = false;
  private idCounter: number = 0;

  constructor(agentPool: AgentPool) {
    super();
    this.agentPool = agentPool;

    // Listen for agent completions to process dependencies
    this.agentPool.on("agent:completed", (agent: SpawnedAgent) => {
      this.onTaskCompleted(agent.task.id);
    });

    this.agentPool.on("agent:failed", (agent: SpawnedAgent) => {
      this.onTaskFailed(agent.task.id);
    });
  }

  /**
   * Add a task to the queue
   */
  enqueue(
    description: string,
    options?: {
      priority?: number;
      dependencies?: string[];
      maxRetries?: number;
    }
  ): QueuedTask {
    const task: QueuedTask = {
      id: this.generateId("qtask"),
      description,
      priority: options?.priority || 1,
      dependencies: options?.dependencies || [],
      retryCount: 0,
      maxRetries: options?.maxRetries || 3,
      createdAt: new Date(),
      status: "idle",
    };

    // Insert sorted by priority (higher priority first)
    const insertIndex = this.queue.findIndex(t => t.priority < task.priority);
    if (insertIndex === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIndex, 0, task);
    }

    this.emit("task:enqueued", task);
    this.processQueue();

    return task;
  }

  /**
   * Process the task queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Find next task with satisfied dependencies
      const taskIndex = this.queue.findIndex(task =>
        this.areDependenciesSatisfied(task)
      );

      if (taskIndex === -1) break; // No tasks ready

      const task = this.queue.splice(taskIndex, 1)[0];
      this.processing.set(task.id, task);

      try {
        const agent = await this.agentPool.spawnAgent(task.description);
        task.agentId = agent.id;
        task.status = "running";
        task.startedAt = new Date();

        this.emit("task:started", task);
      } catch (err) {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        this.processing.delete(task.id);
        this.completed.set(task.id, task);

        this.emit("task:failed", task);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Check if task dependencies are satisfied
   */
  private areDependenciesSatisfied(task: QueuedTask): boolean {
    for (const depId of task.dependencies) {
      const dep = this.completed.get(depId);
      if (!dep || dep.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  /**
   * Handle task completion
   */
  private onTaskCompleted(taskId: string): void {
    const task = this.processing.get(taskId);
    if (!task) return;

    task.status = "completed";
    task.completedAt = new Date();
    this.processing.delete(taskId);
    this.completed.set(taskId, task);

    this.emit("task:completed", task);
    this.processQueue(); // Process any dependent tasks
  }

  /**
   * Handle task failure
   */
  private onTaskFailed(taskId: string): void {
    const task = this.processing.get(taskId);
    if (!task) return;

    if (task.retryCount < task.maxRetries) {
      // Retry the task
      task.retryCount++;
      task.status = "idle";
      this.processing.delete(taskId);
      this.queue.unshift(task); // Add back to front of queue

      this.emit("task:retry", task);
      this.processQueue();
    } else {
      // Mark as permanently failed
      task.status = "failed";
      task.completedAt = new Date();
      this.processing.delete(taskId);
      this.completed.set(taskId, task);

      this.emit("task:failed", task);
    }
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): QueuedTask | undefined {
    return (
      this.queue.find(t => t.id === taskId) ||
      this.processing.get(taskId) ||
      this.completed.get(taskId)
    );
  }

  /**
   * List all queued tasks
   */
  listQueued(): QueuedTask[] {
    return [...this.queue];
  }

  /**
   * List processing tasks
   */
  listProcessing(): QueuedTask[] {
    return Array.from(this.processing.values());
  }

  /**
   * List completed tasks
   */
  listCompleted(): QueuedTask[] {
    return Array.from(this.completed.values());
  }

  /**
   * Get queue stats
   */
  getStats(): {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  } {
    const completedTasks = this.listCompleted();
    return {
      queued: this.queue.length,
      processing: this.processing.size,
      completed: completedTasks.filter(t => t.status === "completed").length,
      failed: completedTasks.filter(t => t.status === "failed").length,
    };
  }

  /**
   * Clear completed tasks
   */
  clearCompleted(): number {
    const count = this.completed.size;
    this.completed.clear();
    return count;
  }

  /**
   * Cancel a queued task
   */
  cancelTask(taskId: string): boolean {
    const queueIndex = this.queue.findIndex(t => t.id === taskId);
    if (queueIndex !== -1) {
      const task = this.queue.splice(queueIndex, 1)[0];
      task.status = "cancelled";
      this.completed.set(taskId, task);
      this.emit("task:cancelled", task);
      return true;
    }

    const processingTask = this.processing.get(taskId);
    if (processingTask && processingTask.agentId) {
      return this.agentPool.cancelAgent(processingTask.agentId);
    }

    return false;
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    this.idCounter++;
    return `${prefix}-${Date.now()}-${this.idCounter}`;
  }
}

// ============================================
// Singleton Instances
// ============================================

let agentPoolInstance: AgentPool | null = null;
let taskQueueInstance: TaskQueue | null = null;

export function getAgentPool(maxConcurrent?: number): AgentPool {
  if (!agentPoolInstance) {
    agentPoolInstance = new AgentPool(maxConcurrent);
  }
  return agentPoolInstance;
}

export function getTaskQueue(): TaskQueue {
  if (!taskQueueInstance) {
    taskQueueInstance = new TaskQueue(getAgentPool());
  }
  return taskQueueInstance;
}

export function resetOrchestration(): void {
  agentPoolInstance = null;
  taskQueueInstance = null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format agent status for display
 */
export function formatAgentStatus(agent: SpawnedAgent): string {
  const statusColors: Record<AgentStatus, string> = {
    idle: "\x1b[33m",    // Yellow
    running: "\x1b[36m", // Cyan
    completed: "\x1b[32m", // Green
    failed: "\x1b[31m",  // Red
    cancelled: "\x1b[90m", // Gray
  };

  const color = statusColors[agent.status] || "";
  const reset = "\x1b[0m";
  const elapsed = agent.completedAt
    ? `${((agent.completedAt.getTime() - agent.startedAt.getTime()) / 1000).toFixed(1)}s`
    : "...";

  return `${color}[${agent.status.toUpperCase()}]${reset} ${agent.id} - ${agent.task.description.slice(0, 40)}... (${elapsed})`;
}

/**
 * Parse /spawn command
 */
export function parseSpawnCommand(input: string): { task: string; options: Partial<AgentConfig> } | null {
  if (!input.startsWith("/spawn ")) return null;

  const rest = input.slice(7).trim();

  // Check for options
  const options: Partial<AgentConfig> = {};
  let task = rest;

  // Parse --model flag
  const modelMatch = rest.match(/--model\s+(\S+)/);
  if (modelMatch) {
    options.model = modelMatch[1];
    task = task.replace(modelMatch[0], "").trim();
  }

  // Parse --dir flag
  const dirMatch = rest.match(/--dir\s+"([^"]+)"|--dir\s+(\S+)/);
  if (dirMatch) {
    options.workingDirectory = dirMatch[1] || dirMatch[2];
    task = task.replace(dirMatch[0], "").trim();
  }

  return { task, options };
}

// ============================================
// Re-export Universal CLI Spawner
// ============================================

export {
  spawnCLIAgent,
  getCLIAgent,
  listCLIAgents,
  getCLIAgentStatus,
  clearFinishedCLIAgents,
  resetCLIAgents,
  type AgentRuntime,
  type CLIAgentOptions,
  type CLIAgentResult,
  type RunningCLIAgent,
} from "./universal-spawner";

// ============================================
// Re-export Subagent System
// ============================================

export {
  SubAgentManager,
  getSubAgentManager,
  resetSubAgentManager,
  formatSubAgentStatus,
  formatSubAgentEvidence,
  type SubAgent,
  type SubAgentConfig,
  type SubAgentStatus,
  type SubAgentMessage,
  type SubAgentEvent,
} from "./subagent";

// Enhanced Delegation System
export {
  DelegationManager,
  getDelegationManager,
  resetDelegationManager,
  generateDelegationPrompt,
  generateHandoffPrompt,
  generateDecompositionPrompt,
  type DelegationRequest,
  type DelegationContext,
  type DelegationConstraints,
  type DelegationResult,
} from "./delegation";

// Multi-agent orchestration
export { OrchestratorBus, getOrchestratorBus } from "./orchestrator-bus";
export type { OrchestratedAgent, SpawnRequest, ChatMessage, BusEvent } from "./orchestrator-bus";
export { PERSONAS, matchPersona, getPersona, listPersonas } from "./personas";
export type { BMADPersona } from "./personas";
export { WorktreeManager } from "./worktree-manager";
export type { WorktreeInfo } from "./worktree-manager";

// Context isolation for multi-agent orchestration
export { ContextManager, getContextManager } from "./context-manager";
export type { ContextPolicy, ContextSlice } from "./context-manager";

// Macro Action Decomposer — coarse-grained parallel task planning
export {
  decompose,
  findParallelGroups,
  findCriticalPath,
  estimatePlan,
  buildPlan,
  createAction,
  formatPlan,
  type MacroAction,
  type MacroActionPlan,
  type DecomposeContext,
  type PlanEstimate,
} from "./macro-actions";

// Token Throughput Tracker — global TPS metrics across agents/sessions/benchmarks
export { ThroughputTracker, getThroughputTracker, resetThroughputTracker } from "./throughput-tracker";
export type { TokenEvent, ThroughputSnapshot, DailyReport, AgentUtilization } from "./throughput-tracker";

// Worktree Pool — parallel sub-agent execution with git isolation
export { WorktreePool } from "./worktree-pool";
export { WorktreeMessaging } from "./worktree-messaging";
export type {
  WorktreeTask,
  WorktreeResult,
  AgentMessage as WorktreeAgentMessage,
  WorktreePoolOptions,
  WorktreeTaskStatus,
} from "./worktree-pool-types";
