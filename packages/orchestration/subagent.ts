/**
 * 8gent Code - Subagent System
 *
 * Manages spawning and orchestrating subagents for complex tasks.
 * Each subagent runs in its own context with isolated message history.
 */

import { EventEmitter } from "events";
import type { Step, Evidence } from "../workflow/plan-validate";
import type { ValidationReport } from "../validation/report";

// ============================================
// Types
// ============================================

export type SubAgentStatus =
  | "planning"
  | "executing"
  | "validating"
  | "complete"
  | "failed"
  | "cancelled";

export interface SubAgentConfig {
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  workingDirectory?: string;
  parentAgentId?: string;
  timeout?: number; // ms
  capabilities?: string[];
  priority?: number;
}

export interface SubAgent {
  id: string;
  task: string;
  status: SubAgentStatus;
  plan: Step[];
  evidence: Evidence[];
  result?: string;
  error?: string;
  config: SubAgentConfig;
  startedAt: Date;
  completedAt?: Date;
  parentId?: string;
  childIds: string[];
  validationReport?: ValidationReport;
  messageHistory: SubAgentMessage[];
  tokenCount: number;
  retryCount: number;
  maxRetries: number;
}

export interface SubAgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: Date;
  toolName?: string;
  toolResult?: string;
}

export interface SubAgentEvent {
  type:
    | "spawned"
    | "planning"
    | "executing"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "validating"
    | "completed"
    | "failed"
    | "cancelled";
  agentId: string;
  data?: unknown;
  timestamp: Date;
}

// ============================================
// SubAgent Manager
// ============================================

export class SubAgentManager extends EventEmitter {
  private agents: Map<string, SubAgent> = new Map();
  private eventLog: SubAgentEvent[] = [];
  private idCounter: number = 0;
  private maxConcurrent: number = 4;
  private runningCount: number = 0;
  private defaultConfig: SubAgentConfig;

  constructor(config?: {
    maxConcurrent?: number;
    defaultConfig?: Partial<SubAgentConfig>;
  }) {
    super();
    this.maxConcurrent = config?.maxConcurrent || 4;
    this.defaultConfig = {
      model: config?.defaultConfig?.model || "glm-4.7-flash:latest",
      maxTurns: config?.defaultConfig?.maxTurns || 20,
      workingDirectory: config?.defaultConfig?.workingDirectory || process.cwd(),
      timeout: config?.defaultConfig?.timeout || 300000, // 5 min default
      capabilities: config?.defaultConfig?.capabilities || [],
      priority: config?.defaultConfig?.priority || 1,
    };
  }

  /**
   * Spawn a new subagent for a task
   * Returns the agent ID immediately
   */
  spawn(task: string, config?: SubAgentConfig): string {
    const agentId = this.generateId();

    const subAgent: SubAgent = {
      id: agentId,
      task,
      status: "planning",
      plan: [],
      evidence: [],
      config: {
        ...this.defaultConfig,
        ...config,
      },
      startedAt: new Date(),
      parentId: config?.parentAgentId,
      childIds: [],
      messageHistory: [],
      tokenCount: 0,
      retryCount: 0,
      maxRetries: 3,
    };

    this.agents.set(agentId, subAgent);

    // Link to parent if specified
    if (config?.parentAgentId) {
      const parent = this.agents.get(config.parentAgentId);
      if (parent) {
        parent.childIds.push(agentId);
      }
    }

    this.logEvent({
      type: "spawned",
      agentId,
      data: { task, config: subAgent.config },
      timestamp: new Date(),
    });

    // Start execution if under concurrency limit
    if (this.runningCount < this.maxConcurrent) {
      this.executeAgent(agentId);
    }

    return agentId;
  }

  /**
   * Get the status of a subagent
   */
  getStatus(id: string): SubAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Wait for a subagent to complete
   */
  async waitFor(id: string, timeoutMs?: number): Promise<SubAgent> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Subagent not found: ${id}`);
    }

    // Already complete
    if (agent.status === "complete" || agent.status === "failed" || agent.status === "cancelled") {
      return agent;
    }

    const timeout = timeoutMs || agent.config.timeout || 300000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for subagent ${id}`));
      }, timeout);

      const checkComplete = (event: SubAgentEvent) => {
        if (event.agentId === id && (
          event.type === "completed" ||
          event.type === "failed" ||
          event.type === "cancelled"
        )) {
          clearTimeout(timer);
          this.off("event", checkComplete);
          const finalAgent = this.agents.get(id);
          if (finalAgent) {
            resolve(finalAgent);
          } else {
            reject(new Error(`Subagent ${id} not found after completion`));
          }
        }
      };

      this.on("event", checkComplete);
    });
  }

  /**
   * Kill a subagent
   */
  killAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    if (agent.status === "complete" || agent.status === "failed" || agent.status === "cancelled") {
      return false; // Already finished
    }

    agent.status = "cancelled";
    agent.completedAt = new Date();

    // Kill any child agents
    for (const childId of agent.childIds) {
      this.killAgent(childId);
    }

    this.logEvent({
      type: "cancelled",
      agentId: id,
      timestamp: new Date(),
    });

    this.runningCount = Math.max(0, this.runningCount - 1);
    this.processQueue();

    return true;
  }

  /**
   * List all subagents
   */
  listAgents(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * List running subagents
   */
  listRunning(): SubAgent[] {
    return this.listAgents().filter(
      (a) => a.status === "planning" || a.status === "executing" || a.status === "validating"
    );
  }

  /**
   * List completed subagents
   */
  listCompleted(): SubAgent[] {
    return this.listAgents().filter((a) => a.status === "complete");
  }

  /**
   * List failed subagents
   */
  listFailed(): SubAgent[] {
    return this.listAgents().filter((a) => a.status === "failed");
  }

  /**
   * Get all evidence from a subagent
   */
  getEvidence(id: string): Evidence[] {
    const agent = this.agents.get(id);
    return agent?.evidence || [];
  }

  /**
   * Get validation report from a subagent
   */
  getValidationReport(id: string): ValidationReport | undefined {
    return this.agents.get(id)?.validationReport;
  }

  /**
   * Clear completed/failed agents
   */
  clearFinished(): number {
    let cleared = 0;
    for (const [id, agent] of this.agents) {
      if (agent.status === "complete" || agent.status === "failed" || agent.status === "cancelled") {
        this.agents.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Get event history for an agent
   */
  getEventHistory(id: string): SubAgentEvent[] {
    return this.eventLog.filter((e) => e.agentId === id);
  }

  /**
   * Get stats
   */
  getStats(): {
    total: number;
    planning: number;
    executing: number;
    validating: number;
    complete: number;
    failed: number;
    cancelled: number;
  } {
    const agents = this.listAgents();
    return {
      total: agents.length,
      planning: agents.filter((a) => a.status === "planning").length,
      executing: agents.filter((a) => a.status === "executing").length,
      validating: agents.filter((a) => a.status === "validating").length,
      complete: agents.filter((a) => a.status === "complete").length,
      failed: agents.filter((a) => a.status === "failed").length,
      cancelled: agents.filter((a) => a.status === "cancelled").length,
    };
  }

  // ============================================
  // Private Methods
  // ============================================

  private async executeAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;

    this.runningCount++;

    try {
      // Import dependencies dynamically
      const { PlanValidateLoop } = await import("../workflow/plan-validate");
      const { EvidenceCollector } = await import("../validation/evidence");
      const { ValidationReporter } = await import("../validation/report");

      // Phase 1: Planning
      this.logEvent({ type: "planning", agentId: id, timestamp: new Date() });
      agent.status = "planning";

      const plan = await this.createPlan(agent);
      agent.plan = plan;

      // Phase 2: Executing with validation
      this.logEvent({ type: "executing", agentId: id, timestamp: new Date() });
      agent.status = "executing";

      const planValidateLoop = new PlanValidateLoop({
        workingDirectory: agent.config.workingDirectory || process.cwd(),
      });
      const evidenceCollector = new EvidenceCollector({
        workingDirectory: agent.config.workingDirectory || process.cwd(),
      });

      // Set up step event handlers
      planValidateLoop.on("step:started", (step: Step) => {
        this.logEvent({
          type: "step_started",
          agentId: id,
          data: { stepId: step.id, action: step.action },
          timestamp: new Date(),
        });
      });

      planValidateLoop.on("step:completed", (step: Step) => {
        agent.evidence.push(...(step.evidence || []));
        this.logEvent({
          type: "step_completed",
          agentId: id,
          data: { stepId: step.id, status: step.status },
          timestamp: new Date(),
        });
      });

      planValidateLoop.on("step:failed", (step: Step) => {
        this.logEvent({
          type: "step_failed",
          agentId: id,
          data: { stepId: step.id, error: step.actual },
          timestamp: new Date(),
        });
      });

      // Execute the plan
      const report = await planValidateLoop.execute(plan, {
        onStepComplete: (step: Step) => {
          agent.plan = plan.map((s) => (s.id === step.id ? step : s));
        },
      });

      // Phase 3: Validation
      this.logEvent({ type: "validating", agentId: id, timestamp: new Date() });
      agent.status = "validating";

      const reporter = new ValidationReporter();
      agent.validationReport = reporter.generateReport(agent.plan, agent.evidence);

      // Complete
      agent.status = "complete";
      agent.completedAt = new Date();
      agent.result = agent.validationReport.summary;

      this.logEvent({
        type: "completed",
        agentId: id,
        data: { confidence: agent.validationReport.confidence },
        timestamp: new Date(),
      });
    } catch (err) {
      agent.status = "failed";
      agent.completedAt = new Date();
      agent.error = err instanceof Error ? err.message : String(err);

      this.logEvent({
        type: "failed",
        agentId: id,
        data: { error: agent.error },
        timestamp: new Date(),
      });
    } finally {
      this.runningCount--;
      this.processQueue();
    }
  }

  private async createPlan(agent: SubAgent): Promise<Step[]> {
    // Import Agent to create a planning request
    const { Agent } = await import("../agent");

    const plannerAgent = new Agent({
      model: agent.config.model || "glm-4.7-flash:latest",
      runtime: "ollama",
      workingDirectory: agent.config.workingDirectory || process.cwd(),
      maxTurns: 5,
    });

    // Generate a plan
    const planPrompt = `Create a detailed execution plan for this task. Output ONLY a JSON array of steps.

Task: ${agent.task}

Format each step as:
{
  "id": "step_1",
  "action": "Description of what to do",
  "expected": "Expected outcome/result"
}

Example:
[
  {"id": "step_1", "action": "Create package.json with project config", "expected": "package.json exists with name and dependencies"},
  {"id": "step_2", "action": "Create src/index.ts entry point", "expected": "src/index.ts exists with main function"}
]

Output ONLY the JSON array, no other text:`;

    try {
      if (!(await plannerAgent.isReady())) {
        throw new Error("Ollama is not running");
      }

      const response = await plannerAgent.chat(planPrompt);

      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Fallback to single-step plan
        return [
          {
            id: "step_1",
            action: agent.task,
            expected: "Task completed successfully",
            status: "pending",
          },
        ];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((step: { id?: string; action: string; expected: string }, index: number) => ({
        id: step.id || `step_${index + 1}`,
        action: step.action,
        expected: step.expected,
        status: "pending" as const,
      }));
    } catch (err) {
      // Fallback plan
      return [
        {
          id: "step_1",
          action: agent.task,
          expected: "Task completed successfully",
          status: "pending",
        },
      ];
    }
  }

  private processQueue(): void {
    // Find idle agents to execute
    for (const [id, agent] of this.agents) {
      if (agent.status === "planning" && this.runningCount < this.maxConcurrent) {
        // Already in planning but not yet executing
        continue;
      }
    }
  }

  private logEvent(event: SubAgentEvent): void {
    this.eventLog.push(event);
    this.emit("event", event);
    this.emit(event.type, event);
  }

  private generateId(): string {
    this.idCounter++;
    return `subagent_${Date.now()}_${this.idCounter}`;
  }
}

// ============================================
// Singleton Instance
// ============================================

let subAgentManagerInstance: SubAgentManager | null = null;

export function getSubAgentManager(config?: {
  maxConcurrent?: number;
  defaultConfig?: Partial<SubAgentConfig>;
}): SubAgentManager {
  if (!subAgentManagerInstance) {
    subAgentManagerInstance = new SubAgentManager(config);
  }
  return subAgentManagerInstance;
}

export function resetSubAgentManager(): void {
  subAgentManagerInstance = null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format subagent status for display
 */
export function formatSubAgentStatus(agent: SubAgent): string {
  const statusColors: Record<SubAgentStatus, string> = {
    planning: "\x1b[33m",   // Yellow
    executing: "\x1b[36m",  // Cyan
    validating: "\x1b[35m", // Magenta
    complete: "\x1b[32m",   // Green
    failed: "\x1b[31m",     // Red
    cancelled: "\x1b[90m",  // Gray
  };

  const color = statusColors[agent.status] || "";
  const reset = "\x1b[0m";
  const elapsed = agent.completedAt
    ? `${((agent.completedAt.getTime() - agent.startedAt.getTime()) / 1000).toFixed(1)}s`
    : "...";

  const stepProgress = agent.plan.length > 0
    ? `${agent.plan.filter((s) => s.status === "passed").length}/${agent.plan.length}`
    : "0/0";

  return `${color}[${agent.status.toUpperCase()}]${reset} ${agent.id.slice(0, 20)} - ${agent.task.slice(0, 40)}... (${stepProgress} steps, ${elapsed})`;
}

/**
 * Format subagent evidence for display
 */
export function formatSubAgentEvidence(agent: SubAgent): string {
  if (agent.evidence.length === 0) {
    return "No evidence collected yet.";
  }

  const lines: string[] = ["Evidence:"];
  for (const ev of agent.evidence) {
    const icon = ev.verified ? "\x1b[32m✓\x1b[0m" : "\x1b[33m?\x1b[0m";
    lines.push(`  ${icon} [${ev.type}] ${ev.description}`);
  }

  return lines.join("\n");
}
