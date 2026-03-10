/**
 * 8gent Code - Planner
 *
 * The brain of 8gent. Analyzes tasks, creates execution plans,
 * and orchestrates AST-first exploration for maximum token efficiency.
 *
 * Philosophy: plan → retrieve → compose → verify
 * (not: search → read → guess → patch)
 */

import type { Tool, ExecutionContext, Symbol } from "../types";
import { getToolRegistry } from "../toolshed/registry";

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  tokensUsed?: number;
  tokensSaved?: number;
}

export interface ExecutionPlan {
  id: string;
  task: string;
  context: PlanningContext;
  steps: PlanStep[];
  estimatedTokens: number;
  actualTokens: number;
  tokensSaved: number;
  status: "planning" | "executing" | "completed" | "failed";
  startedAt: Date;
  completedAt?: Date;
}

export interface PlanningContext {
  files: string[];
  symbols: Symbol[];
  relevantTools: string[];
  constraints: string[];
}

export interface PlannerOptions {
  maxSteps?: number;
  preferAstFirst?: boolean;
  verbosity?: "minimal" | "normal" | "verbose";
}

/**
 * The Planner class - core intelligence for 8gent
 */
export class Planner {
  private options: Required<PlannerOptions>;
  private plans: Map<string, ExecutionPlan> = new Map();

  constructor(options: PlannerOptions = {}) {
    this.options = {
      maxSteps: options.maxSteps ?? 20,
      preferAstFirst: options.preferAstFirst ?? true,
      verbosity: options.verbosity ?? "normal",
    };
  }

  /**
   * Create an execution plan for a task
   */
  async plan(task: string, context: ExecutionContext): Promise<ExecutionPlan> {
    const planId = this.generateId();
    const planningContext = await this.gatherContext(task, context);

    const steps = await this.generateSteps(task, planningContext, context);
    const estimatedTokens = this.estimateTokens(steps);

    const plan: ExecutionPlan = {
      id: planId,
      task,
      context: planningContext,
      steps,
      estimatedTokens,
      actualTokens: 0,
      tokensSaved: 0,
      status: "planning",
      startedAt: new Date(),
    };

    this.plans.set(planId, plan);
    return plan;
  }

  /**
   * Execute a plan step by step
   */
  async execute(plan: ExecutionPlan, context: ExecutionContext): Promise<ExecutionPlan> {
    plan.status = "executing";

    for (const step of plan.steps) {
      // Check dependencies
      const dependenciesMet = step.dependsOn.every(depId => {
        const dep = plan.steps.find(s => s.id === depId);
        return dep?.status === "completed";
      });

      if (!dependenciesMet) {
        continue;
      }

      step.status = "running";

      try {
        const result = await this.executeStep(step, plan, context);
        step.result = result;
        step.status = "completed";

        // Track tokens
        if (typeof result === "object" && result !== null && "tokensSaved" in result) {
          step.tokensSaved = (result as { tokensSaved: number }).tokensSaved;
          plan.tokensSaved += step.tokensSaved;
        }
      } catch (error) {
        step.status = "failed";
        plan.status = "failed";
        throw error;
      }
    }

    plan.status = "completed";
    plan.completedAt = new Date();
    return plan;
  }

  /**
   * Gather context for planning using AST-first approach
   */
  private async gatherContext(
    task: string,
    context: ExecutionContext
  ): Promise<PlanningContext> {
    const registry = getToolRegistry();
    const relevantTools = this.identifyRelevantTools(task, registry);

    // Analyze task to identify relevant files and symbols
    const taskLower = task.toLowerCase();
    const constraints: string[] = [];

    // Add efficiency constraints
    if (this.options.preferAstFirst) {
      constraints.push("Use get_outline before reading full files");
      constraints.push("Use get_symbol for specific code retrieval");
      constraints.push("Prefer search_symbols over grep for code search");
    }

    return {
      files: [],
      symbols: [],
      relevantTools,
      constraints,
    };
  }

  /**
   * Generate execution steps based on task analysis
   */
  private async generateSteps(
    task: string,
    planningContext: PlanningContext,
    context: ExecutionContext
  ): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];
    const taskLower = task.toLowerCase();

    // Pattern matching for common task types
    if (this.isCodeExplorationTask(taskLower)) {
      steps.push(...this.generateExplorationSteps(task, planningContext));
    } else if (this.isCodeModificationTask(taskLower)) {
      steps.push(...this.generateModificationSteps(task, planningContext));
    } else if (this.isSearchTask(taskLower)) {
      steps.push(...this.generateSearchSteps(task, planningContext));
    } else {
      // Generic task - start with exploration
      steps.push({
        id: this.generateId(),
        description: "Explore relevant files",
        tool: "get_outline",
        input: { filePath: "." },
        dependsOn: [],
        status: "pending",
      });
    }

    return steps;
  }

  /**
   * Identify relevant tools for a task
   */
  private identifyRelevantTools(task: string, registry: Map<string, Tool>): string[] {
    const tools: string[] = [];
    const taskLower = task.toLowerCase();

    // Code tools
    if (taskLower.includes("function") || taskLower.includes("class") ||
        taskLower.includes("method") || taskLower.includes("code")) {
      tools.push("get_outline", "get_symbol", "search_symbols");
    }

    // File tools
    if (taskLower.includes("file") || taskLower.includes("read") || taskLower.includes("write")) {
      tools.push("get_outline", "get_symbol");
    }

    // Search tools
    if (taskLower.includes("find") || taskLower.includes("search") || taskLower.includes("where")) {
      tools.push("search_symbols");
    }

    return [...new Set(tools)];
  }

  /**
   * Check if task is code exploration
   */
  private isCodeExplorationTask(task: string): boolean {
    const patterns = [
      "understand", "explore", "what does", "how does", "explain",
      "show me", "find", "where is", "look at", "analyze"
    ];
    return patterns.some(p => task.includes(p));
  }

  /**
   * Check if task is code modification
   */
  private isCodeModificationTask(task: string): boolean {
    const patterns = [
      "fix", "change", "update", "modify", "add", "remove",
      "refactor", "implement", "create", "delete"
    ];
    return patterns.some(p => task.includes(p));
  }

  /**
   * Check if task is a search task
   */
  private isSearchTask(task: string): boolean {
    const patterns = [
      "find", "search", "locate", "where", "which file"
    ];
    return patterns.some(p => task.includes(p));
  }

  /**
   * Generate steps for code exploration
   */
  private generateExplorationSteps(
    task: string,
    ctx: PlanningContext
  ): PlanStep[] {
    return [
      {
        id: this.generateId(),
        description: "Get file outline to understand structure",
        tool: "get_outline",
        input: { filePath: "." },
        dependsOn: [],
        status: "pending",
      },
      {
        id: this.generateId(),
        description: "Search for relevant symbols",
        tool: "search_symbols",
        input: { query: task.split(" ").slice(0, 3).join(" ") },
        dependsOn: [],
        status: "pending",
      },
    ];
  }

  /**
   * Generate steps for code modification
   */
  private generateModificationSteps(
    task: string,
    ctx: PlanningContext
  ): PlanStep[] {
    const outlineStep: PlanStep = {
      id: this.generateId(),
      description: "Get outline of affected files",
      tool: "get_outline",
      input: { filePath: "." },
      dependsOn: [],
      status: "pending",
    };

    const symbolStep: PlanStep = {
      id: this.generateId(),
      description: "Retrieve specific symbol to modify",
      tool: "get_symbol",
      input: { symbolId: "to-be-determined" },
      dependsOn: [outlineStep.id],
      status: "pending",
    };

    return [outlineStep, symbolStep];
  }

  /**
   * Generate steps for search tasks
   */
  private generateSearchSteps(
    task: string,
    ctx: PlanningContext
  ): PlanStep[] {
    // Extract search query from task
    const query = task.replace(/find|search|locate|where|which/gi, "").trim();

    return [
      {
        id: this.generateId(),
        description: `Search for symbols matching: ${query}`,
        tool: "search_symbols",
        input: { query, limit: 10 },
        dependsOn: [],
        status: "pending",
      },
    ];
  }

  /**
   * Execute a single plan step
   */
  private async executeStep(
    step: PlanStep,
    plan: ExecutionPlan,
    context: ExecutionContext
  ): Promise<unknown> {
    const registry = getToolRegistry();
    const tool = registry.get(step.tool);

    if (!tool) {
      throw new Error(`Tool not found: ${step.tool}`);
    }

    // Resolve dynamic inputs from previous step results
    const resolvedInput = this.resolveInputs(step.input, plan);

    return await tool.execute(resolvedInput, context);
  }

  /**
   * Resolve dynamic inputs from previous step results
   */
  private resolveInputs(
    input: Record<string, unknown>,
    plan: ExecutionPlan
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string" && value.startsWith("$")) {
        // Reference to previous step result
        const [stepId, path] = value.slice(1).split(".");
        const step = plan.steps.find(s => s.id === stepId);
        if (step?.result) {
          resolved[key] = this.extractPath(step.result, path);
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Extract nested path from object
   */
  private extractPath(obj: unknown, path: string): unknown {
    if (!path) return obj;
    const parts = path.split(".");
    let current = obj as Record<string, unknown>;
    for (const part of parts) {
      if (current && typeof current === "object") {
        current = current[part] as Record<string, unknown>;
      }
    }
    return current;
  }

  /**
   * Estimate tokens for a plan
   */
  private estimateTokens(steps: PlanStep[]): number {
    // Rough estimate based on step types
    let estimate = 0;
    for (const step of steps) {
      switch (step.tool) {
        case "get_outline":
          estimate += 500; // Outlines are compact
          break;
        case "get_symbol":
          estimate += 300; // Single symbol retrieval
          break;
        case "search_symbols":
          estimate += 400; // Search results
          break;
        default:
          estimate += 1000; // Conservative estimate
      }
    }
    return estimate;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Get plan by ID
   */
  getPlan(planId: string): ExecutionPlan | undefined {
    return this.plans.get(planId);
  }

  /**
   * Get all plans
   */
  getAllPlans(): ExecutionPlan[] {
    return Array.from(this.plans.values());
  }

  /**
   * Get efficiency stats
   */
  getEfficiencyStats(): { totalTokensSaved: number; planCount: number; avgSavings: number } {
    const plans = this.getAllPlans();
    const totalTokensSaved = plans.reduce((sum, p) => sum + p.tokensSaved, 0);
    return {
      totalTokensSaved,
      planCount: plans.length,
      avgSavings: plans.length > 0 ? totalTokensSaved / plans.length : 0,
    };
  }
}

// Singleton instance
let plannerInstance: Planner | null = null;

export function getPlanner(options?: PlannerOptions): Planner {
  if (!plannerInstance) {
    plannerInstance = new Planner(options);
  }
  return plannerInstance;
}

export function resetPlanner(): void {
  plannerInstance = null;
}
