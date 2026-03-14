/**
 * 8gent Code - Infinite Mode
 *
 * The "dangerously autonomous" execution mode.
 * Runs until success criteria is met, no questions asked.
 *
 * Features:
 * - Loops until task completion
 * - Catches all errors and feeds them back to the agent
 * - No user interaction required
 * - Self-healing: crashes become context for next attempt
 * - Success validation before exit
 */

import { EventEmitter } from "events";
import { enableInfiniteMode, disableInfiniteMode } from "../permissions";

// ============================================
// Types
// ============================================

export interface InfiniteConfig {
  /** Maximum iterations before forced stop (safety valve) */
  maxIterations?: number;
  /** Maximum time in ms before forced stop */
  maxTimeMs?: number;
  /** Success criteria function - returns true when task is complete */
  successCriteria?: (state: InfiniteState) => boolean | Promise<boolean>;
  /** Custom success validation prompt for LLM */
  successPrompt?: string;
  /** Whether to auto-validate success with LLM */
  autoValidate?: boolean;
  /** Callback for each iteration */
  onIteration?: (state: InfiniteState) => void;
  /** Callback when error is recovered */
  onErrorRecovered?: (error: Error, state: InfiniteState) => void;
  /** Model to use */
  model?: string;
  /** Working directory */
  workingDirectory?: string;
}

export interface InfiniteState {
  /** Current iteration number */
  iteration: number;
  /** Total elapsed time in ms */
  elapsedMs: number;
  /** Start time */
  startTime: Date;
  /** Errors encountered and recovered from */
  recoveredErrors: ErrorRecord[];
  /** Last agent response */
  lastResponse?: string;
  /** Files created/modified */
  filesChanged: string[];
  /** Commands executed */
  commandsExecuted: string[];
  /** Current phase (plan/execute/validate) */
  phase: "plan" | "execute" | "validate" | "complete" | "failed";
  /** Completion percentage estimate */
  progressEstimate: number;
  /** The original task */
  task: string;
  /** Intermediate results */
  results: string[];
}

export interface ErrorRecord {
  error: Error;
  iteration: number;
  timestamp: Date;
  recovery: string;
}

export type InfiniteEvent =
  | "start"
  | "iteration"
  | "error"
  | "recovered"
  | "progress"
  | "validating"
  | "success"
  | "timeout"
  | "maxIterations"
  | "abort";

// ============================================
// Default Success Criteria
// ============================================

const DEFAULT_SUCCESS_PROMPT = `You are validating whether a task was completed successfully.

Original task: {{TASK}}

Current state:
- Iterations completed: {{ITERATIONS}}
- Files changed: {{FILES}}
- Commands executed: {{COMMANDS}}
- Last response: {{LAST_RESPONSE}}
- Recovered errors: {{ERRORS}}

Based on this information, answer ONLY with:
- "SUCCESS" if the task appears to be fully completed
- "CONTINUE" if more work is needed
- "FAILED: <reason>" if the task cannot be completed

Your response:`;

// ============================================
// Infinite Loop Runner
// ============================================

export class InfiniteRunner extends EventEmitter {
  private config: Required<InfiniteConfig>;
  private state: InfiniteState;
  private aborted: boolean = false;
  private agent: any = null;

  constructor(task: string, config: InfiniteConfig = {}) {
    super();

    this.config = {
      maxIterations: config.maxIterations ?? 100,
      maxTimeMs: config.maxTimeMs ?? 30 * 60 * 1000, // 30 minutes default
      successCriteria: config.successCriteria ?? this.defaultSuccessCriteria.bind(this),
      successPrompt: config.successPrompt ?? DEFAULT_SUCCESS_PROMPT,
      autoValidate: config.autoValidate ?? true,
      onIteration: config.onIteration ?? (() => {}),
      onErrorRecovered: config.onErrorRecovered ?? (() => {}),
      model: config.model ?? "glm-4.7-flash:latest",
      workingDirectory: config.workingDirectory ?? process.cwd(),
    };

    this.state = {
      iteration: 0,
      elapsedMs: 0,
      startTime: new Date(),
      recoveredErrors: [],
      filesChanged: [],
      commandsExecuted: [],
      phase: "plan",
      progressEstimate: 0,
      task,
      results: [],
    };
  }

  /**
   * Run the infinite loop until success or limits reached
   */
  async run(): Promise<InfiniteState> {
    this.emit("start", this.state);

    // ENABLE INFINITE MODE - bypass all permission checks
    enableInfiniteMode();

    try {
      // Import Agent dynamically to avoid circular deps
      const { Agent } = await import("../eight");

      this.agent = new Agent({
        model: this.config.model,
        runtime: "ollama",
        workingDirectory: this.config.workingDirectory,
        maxTurns: 50, // Higher for infinite mode
      });

      // Check Ollama availability
      if (!(await this.agent.isReady())) {
        throw new Error("Ollama is not running. Please start Ollama first.");
      }

      // Main infinite loop
      while (!this.aborted) {
        this.state.iteration++;
        this.state.elapsedMs = Date.now() - this.state.startTime.getTime();

        // Safety checks
        if (this.state.iteration > this.config.maxIterations) {
          this.emit("maxIterations", this.state);
          this.state.phase = "failed";
          break;
        }

        if (this.state.elapsedMs > this.config.maxTimeMs) {
          this.emit("timeout", this.state);
          this.state.phase = "failed";
          break;
        }

        this.emit("iteration", this.state);
        this.config.onIteration(this.state);

        try {
          // Build context with error recovery info
          const prompt = this.buildPrompt();

          // Execute agent turn
          const response = await this.agent.chat(prompt);
          this.state.lastResponse = response;
          this.state.results.push(response);

          // Update progress estimate based on response content
          this.updateProgress(response);

          // Check success criteria
          if (this.config.autoValidate) {
            this.state.phase = "validate";
            this.emit("validating", this.state);

            const isSuccess = await this.config.successCriteria(this.state);
            if (isSuccess) {
              this.state.phase = "complete";
              this.emit("success", this.state);
              break;
            }
          }

          this.state.phase = "execute";

        } catch (error) {
          // Self-healing: capture error and feed back to agent
          const err = error instanceof Error ? error : new Error(String(error));
          const recovery = this.buildErrorRecoveryPrompt(err);

          this.state.recoveredErrors.push({
            error: err,
            iteration: this.state.iteration,
            timestamp: new Date(),
            recovery,
          });

          this.emit("error", { error: err, state: this.state });
          this.emit("recovered", { error: err, state: this.state });
          this.config.onErrorRecovered(err, this.state);

          // Feed error back to agent as context
          try {
            await this.agent.chat(recovery);
          } catch {
            // If even recovery fails, continue to next iteration
          }
        }
      }

      if (this.aborted) {
        this.state.phase = "failed";
        this.emit("abort", this.state);
      }

    } catch (error) {
      this.state.phase = "failed";
      const err = error instanceof Error ? error : new Error(String(error));
      this.state.recoveredErrors.push({
        error: err,
        iteration: this.state.iteration,
        timestamp: new Date(),
        recovery: "Fatal error - could not recover",
      });
    } finally {
      // DISABLE INFINITE MODE when done
      disableInfiniteMode();
    }

    return this.state;
  }

  /**
   * Abort the infinite loop
   */
  abort(): void {
    this.aborted = true;
    this.emit("abort", this.state);
  }

  /**
   * Get current state
   */
  getState(): InfiniteState {
    return { ...this.state };
  }

  /**
   * Build the prompt for this iteration
   */
  private buildPrompt(): string {
    if (this.state.iteration === 1) {
      // First iteration - just the task with INFINITE MODE context
      return `🔄 INFINITE MODE ACTIVE

You are in INFINITE MODE - autonomous execution until completion.
DO NOT ask questions. DO NOT wait for confirmation. JUST EXECUTE.

If something fails, try a different approach automatically.
If you need to create files, CREATE THEM.
If you need to run commands, RUN THEM.

TASK: ${this.state.task}

BEGIN EXECUTION NOW. Output your PLAN first, then IMMEDIATELY start executing.`;
    }

    // Subsequent iterations - include context
    let prompt = `🔄 INFINITE MODE - Iteration ${this.state.iteration}

Continue working on the task. You've made progress:
- Files changed: ${this.state.filesChanged.length}
- Commands run: ${this.state.commandsExecuted.length}
- Progress: ~${this.state.progressEstimate}%

`;

    // Add error context if any
    if (this.state.recoveredErrors.length > 0) {
      const recentErrors = this.state.recoveredErrors.slice(-3);
      prompt += `\nRecent errors (already recovered, context only):
${recentErrors.map(e => `- ${e.error.message}`).join("\n")}

`;
    }

    prompt += `Continue execution. What's the next step?`;

    return prompt;
  }

  /**
   * Build error recovery prompt
   */
  private buildErrorRecoveryPrompt(error: Error): string {
    return `⚠️ ERROR ENCOUNTERED (Auto-recovering)

Error: ${error.message}

This error occurred during execution. DO NOT STOP.
Analyze the error and try a DIFFERENT approach:
1. If a command failed, try an alternative command
2. If a file operation failed, check paths and permissions
3. If npm/npx hangs, use bun instead
4. If something requires input, add --yes or -y flags

What alternative approach will you try now?`;
  }

  /**
   * Default success criteria using LLM validation
   */
  private async defaultSuccessCriteria(state: InfiniteState): Promise<boolean> {
    if (!this.agent) return false;

    try {
      const prompt = this.config.successPrompt
        .replace("{{TASK}}", state.task)
        .replace("{{ITERATIONS}}", state.iteration.toString())
        .replace("{{FILES}}", state.filesChanged.join(", ") || "none")
        .replace("{{COMMANDS}}", state.commandsExecuted.slice(-10).join(", ") || "none")
        .replace("{{LAST_RESPONSE}}", state.lastResponse?.slice(0, 500) || "none")
        .replace("{{ERRORS}}", state.recoveredErrors.length.toString());

      const response = await this.agent.chat(prompt);

      if (response.toUpperCase().includes("SUCCESS")) {
        return true;
      }

      if (response.toUpperCase().startsWith("FAILED:")) {
        // Mark as permanently failed
        this.state.phase = "failed";
        return true; // Exit the loop
      }

      return false; // Continue
    } catch {
      return false; // On error, continue trying
    }
  }

  /**
   * Update progress estimate based on response
   */
  private updateProgress(response: string): void {
    // Extract file operations
    const fileMatches = response.match(/write_file|edit_file|created|modified/gi);
    if (fileMatches) {
      this.state.filesChanged.push(`iteration-${this.state.iteration}`);
    }

    // Extract command executions
    const cmdMatches = response.match(/run_command|npm|bun|git/gi);
    if (cmdMatches) {
      this.state.commandsExecuted.push(`cmd-${this.state.iteration}`);
    }

    // Rough progress estimate based on iteration and phase keywords
    const hasComplete = response.match(/complete|done|finished|success/i);
    const hasPlan = response.match(/PLAN:|step \d|1\)|2\)|3\)/i);

    if (hasComplete) {
      this.state.progressEstimate = Math.min(95, this.state.progressEstimate + 20);
    } else if (hasPlan && this.state.iteration <= 2) {
      this.state.progressEstimate = 10;
    } else {
      this.state.progressEstimate = Math.min(90, this.state.progressEstimate + 5);
    }

    this.emit("progress", this.state);
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create and run an infinite loop for a task
 */
export async function runInfinite(
  task: string,
  config?: InfiniteConfig
): Promise<InfiniteState> {
  const runner = new InfiniteRunner(task, config);
  return runner.run();
}

/**
 * Create an infinite runner (for manual control)
 */
export function createInfiniteRunner(
  task: string,
  config?: InfiniteConfig
): InfiniteRunner {
  return new InfiniteRunner(task, config);
}

// ============================================
// CLI Integration Helper
// ============================================

export function formatInfiniteState(state: InfiniteState): string {
  const statusColors: Record<string, string> = {
    plan: "\x1b[33m",      // Yellow
    execute: "\x1b[36m",   // Cyan
    validate: "\x1b[35m",  // Magenta
    complete: "\x1b[32m",  // Green
    failed: "\x1b[31m",    // Red
  };

  const color = statusColors[state.phase] || "";
  const reset = "\x1b[0m";
  const elapsed = (state.elapsedMs / 1000).toFixed(1);

  return `${color}[${state.phase.toUpperCase()}]${reset} Iteration ${state.iteration} | ${elapsed}s | ~${state.progressEstimate}% | Errors recovered: ${state.recoveredErrors.length}`;
}

// ============================================
// Exports
// ============================================

export default {
  InfiniteRunner,
  runInfinite,
  createInfiniteRunner,
  formatInfiniteState,
};
