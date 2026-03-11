/**
 * 8gent Code - Proactive Planning Engine
 *
 * Always maintains 10 steps ahead by predicting likely user requests
 * and pre-generating execution plans for each predicted path.
 *
 * Uses a Kanban-style structure:
 * - backlog: Predicted future tasks
 * - ready: Next immediate options
 * - inProgress: Currently executing
 * - done: Completed
 */

// Types are defined inline to avoid circular dependencies

export interface ExecutionContext {
  sessionId: string;
  workingDirectory: string;
  permissions: string[];
  sandbox: {
    type: string;
    allowedPaths: string[];
    networkAccess: boolean;
    timeout: number;
  };
}

// ============================================
// Types
// ============================================

export interface ProactiveStep {
  id: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  priority: number; // 1-10, higher = more likely to be requested
  confidence: number; // 0-1, prediction confidence
  category: StepCategory;
  predictedAt: Date;
  basedOn: string[]; // IDs of completed steps that led to this prediction
}

export type StepCategory =
  | "exploration" // Understanding code
  | "modification" // Changing code
  | "search" // Finding things
  | "git" // Version control
  | "test" // Testing
  | "debug" // Debugging
  | "refactor" // Code improvement
  | "documentation"; // Docs

export interface KanbanBoard {
  backlog: ProactiveStep[];
  ready: ProactiveStep[];
  inProgress: ProactiveStep[];
  done: ProactiveStep[];
}

export interface PredictionContext {
  recentCommands: string[];
  currentPlan: ExecutionPlan | null;
  currentDirectory: string;
  isGitRepo: boolean;
  branch: string | null;
  modifiedFiles: string[];
  lastError: string | null;
  sessionDuration: number; // in seconds
}

// ============================================
// Proactive Planner
// ============================================

export class ProactivePlanner {
  private board: KanbanBoard;
  private predictionContext: PredictionContext;
  private maxBacklog = 10;
  private maxReady = 5;

  constructor() {
    this.board = {
      backlog: [],
      ready: [],
      inProgress: [],
      done: [],
    };

    this.predictionContext = {
      recentCommands: [],
      currentPlan: null,
      currentDirectory: process.cwd(),
      isGitRepo: false,
      branch: null,
      modifiedFiles: [],
      lastError: null,
      sessionDuration: 0,
    };
  }

  /**
   * Predict next likely steps based on current context
   */
  async predictNextSteps(context: ExecutionContext): Promise<ProactiveStep[]> {
    const predictions: ProactiveStep[] = [];

    // Context-aware predictions
    if (this.predictionContext.isGitRepo) {
      predictions.push(...this.predictGitSteps());
    }

    if (this.predictionContext.lastError) {
      predictions.push(...this.predictDebugSteps());
    }

    if (this.predictionContext.currentPlan) {
      predictions.push(...this.predictPlanContinuation());
    }

    if (this.predictionContext.modifiedFiles.length > 0) {
      predictions.push(...this.predictPostModificationSteps());
    }

    // Always include exploration steps
    predictions.push(...this.predictExplorationSteps());

    // Sort by priority and confidence
    predictions.sort((a, b) => {
      const scoreA = a.priority * a.confidence;
      const scoreB = b.priority * b.confidence;
      return scoreB - scoreA;
    });

    // Update the board
    this.updateBoard(predictions);

    return predictions.slice(0, this.maxBacklog);
  }

  /**
   * Predict git-related steps
   */
  private predictGitSteps(): ProactiveStep[] {
    const steps: ProactiveStep[] = [];

    if (this.predictionContext.modifiedFiles.length > 0) {
      steps.push({
        id: this.generateId(),
        description: "Stage and commit changes",
        tool: "exec",
        input: { command: "git add -A && git commit" },
        priority: 8,
        confidence: 0.7,
        category: "git",
        predictedAt: new Date(),
        basedOn: [],
      });

      steps.push({
        id: this.generateId(),
        description: "View diff of changes",
        tool: "exec",
        input: { command: "git diff" },
        priority: 7,
        confidence: 0.8,
        category: "git",
        predictedAt: new Date(),
        basedOn: [],
      });
    }

    if (this.predictionContext.branch && this.predictionContext.branch !== "main") {
      steps.push({
        id: this.generateId(),
        description: "Create pull request",
        tool: "exec",
        input: { command: "gh pr create" },
        priority: 6,
        confidence: 0.5,
        category: "git",
        predictedAt: new Date(),
        basedOn: [],
      });
    }

    return steps;
  }

  /**
   * Predict debug-related steps
   */
  private predictDebugSteps(): ProactiveStep[] {
    const steps: ProactiveStep[] = [];

    steps.push({
      id: this.generateId(),
      description: "Search for error in codebase",
      tool: "search_symbols",
      input: { query: this.extractErrorKeywords() },
      priority: 9,
      confidence: 0.9,
      category: "debug",
      predictedAt: new Date(),
      basedOn: [],
    });

    steps.push({
      id: this.generateId(),
      description: "Check related test files",
      tool: "get_outline",
      input: { pattern: "**/*.test.ts" },
      priority: 7,
      confidence: 0.6,
      category: "test",
      predictedAt: new Date(),
      basedOn: [],
    });

    return steps;
  }

  /**
   * Predict continuation steps for current plan
   */
  private predictPlanContinuation(): ProactiveStep[] {
    const steps: ProactiveStep[] = [];
    const plan = this.predictionContext.currentPlan;

    if (!plan) return steps;

    // Find next pending steps in the plan
    const pendingSteps = plan.steps.filter((s) => s.status === "pending");
    for (const step of pendingSteps.slice(0, 3)) {
      steps.push({
        id: this.generateId(),
        description: step.description,
        tool: step.tool,
        input: step.input,
        priority: 10,
        confidence: 1.0,
        category: "exploration",
        predictedAt: new Date(),
        basedOn: [plan.id],
      });
    }

    return steps;
  }

  /**
   * Predict steps after code modification
   */
  private predictPostModificationSteps(): ProactiveStep[] {
    const steps: ProactiveStep[] = [];

    steps.push({
      id: this.generateId(),
      description: "Run tests",
      tool: "exec",
      input: { command: "npm test" },
      priority: 9,
      confidence: 0.8,
      category: "test",
      predictedAt: new Date(),
      basedOn: [],
    });

    steps.push({
      id: this.generateId(),
      description: "Check for type errors",
      tool: "exec",
      input: { command: "tsc --noEmit" },
      priority: 8,
      confidence: 0.7,
      category: "debug",
      predictedAt: new Date(),
      basedOn: [],
    });

    steps.push({
      id: this.generateId(),
      description: "Run linter",
      tool: "exec",
      input: { command: "npm run lint" },
      priority: 6,
      confidence: 0.6,
      category: "refactor",
      predictedAt: new Date(),
      basedOn: [],
    });

    return steps;
  }

  /**
   * Predict exploration steps
   */
  private predictExplorationSteps(): ProactiveStep[] {
    const steps: ProactiveStep[] = [];

    // Based on recent commands, predict likely exploration targets
    const recentPatterns = this.analyzeRecentCommands();

    for (const pattern of recentPatterns) {
      steps.push({
        id: this.generateId(),
        description: `Explore ${pattern.target}`,
        tool: "get_outline",
        input: { filePath: pattern.path },
        priority: pattern.priority,
        confidence: pattern.confidence,
        category: "exploration",
        predictedAt: new Date(),
        basedOn: [],
      });
    }

    // Default exploration suggestions
    steps.push({
      id: this.generateId(),
      description: "View package structure",
      tool: "get_outline",
      input: { filePath: "package.json" },
      priority: 3,
      confidence: 0.3,
      category: "exploration",
      predictedAt: new Date(),
      basedOn: [],
    });

    return steps;
  }

  /**
   * Update the kanban board with new predictions
   */
  private updateBoard(predictions: ProactiveStep[]): void {
    // Move high-confidence predictions to ready
    const ready = predictions.filter((p) => p.confidence >= 0.7).slice(0, this.maxReady);
    const backlog = predictions.filter((p) => p.confidence < 0.7);

    this.board.ready = ready;
    this.board.backlog = backlog.slice(0, this.maxBacklog);
  }

  /**
   * Mark a step as started
   */
  startStep(stepId: string): ProactiveStep | null {
    const step = this.findStep(stepId);
    if (!step) return null;

    // Remove from ready/backlog
    this.board.ready = this.board.ready.filter((s) => s.id !== stepId);
    this.board.backlog = this.board.backlog.filter((s) => s.id !== stepId);

    // Add to in progress
    this.board.inProgress.push(step);

    return step;
  }

  /**
   * Mark a step as completed
   */
  completeStep(stepId: string): ProactiveStep | null {
    const index = this.board.inProgress.findIndex((s) => s.id === stepId);
    if (index === -1) return null;

    const [step] = this.board.inProgress.splice(index, 1);
    this.board.done.push(step);

    // Trigger new predictions based on completed step
    this.updatePredictionContext({ completedStep: step });

    return step;
  }

  /**
   * Update prediction context
   */
  updatePredictionContext(update: Partial<PredictionContext> & { completedStep?: ProactiveStep }): void {
    if (update.recentCommands) {
      this.predictionContext.recentCommands = [
        ...update.recentCommands,
        ...this.predictionContext.recentCommands,
      ].slice(0, 20);
    }

    Object.assign(this.predictionContext, update);
  }

  /**
   * Get the current kanban board
   */
  getBoard(): KanbanBoard {
    return { ...this.board };
  }

  /**
   * Get ready steps (high confidence, immediate)
   */
  getReadySteps(): ProactiveStep[] {
    return [...this.board.ready];
  }

  /**
   * Get the next recommended step
   */
  getNextRecommendedStep(): ProactiveStep | null {
    return this.board.ready[0] || this.board.backlog[0] || null;
  }

  /**
   * Clear predictions
   */
  clearPredictions(): void {
    this.board.backlog = [];
    this.board.ready = [];
  }

  // ============================================
  // Private Helpers
  // ============================================

  private generateId(): string {
    return `proactive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private findStep(stepId: string): ProactiveStep | null {
    return (
      this.board.ready.find((s) => s.id === stepId) ||
      this.board.backlog.find((s) => s.id === stepId) ||
      null
    );
  }

  private extractErrorKeywords(): string {
    const error = this.predictionContext.lastError || "";
    // Extract meaningful keywords from error message
    const keywords = error
      .split(/[\s:]+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);
    return keywords.join(" ");
  }

  private analyzeRecentCommands(): Array<{
    target: string;
    path: string;
    priority: number;
    confidence: number;
  }> {
    const patterns: Array<{
      target: string;
      path: string;
      priority: number;
      confidence: number;
    }> = [];

    const commands = this.predictionContext.recentCommands;

    // Look for file path patterns in recent commands
    for (const cmd of commands.slice(0, 5)) {
      const fileMatch = cmd.match(/(?:src|lib|packages)\/[\w/.-]+\.(ts|tsx|js|jsx)/);
      if (fileMatch) {
        const path = fileMatch[0];
        const dir = path.split("/").slice(0, -1).join("/");
        patterns.push({
          target: `files in ${dir}`,
          path: dir,
          priority: 5,
          confidence: 0.5,
        });
      }
    }

    return patterns;
  }
}

// Singleton instance
let proactivePlannerInstance: ProactivePlanner | null = null;

export function getProactivePlanner(): ProactivePlanner {
  if (!proactivePlannerInstance) {
    proactivePlannerInstance = new ProactivePlanner();
  }
  return proactivePlannerInstance;
}

export function resetProactivePlanner(): void {
  proactivePlannerInstance = null;
}
