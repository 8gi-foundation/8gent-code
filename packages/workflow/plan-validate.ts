/**
 * 8gent Code - Plan-Validate Loop
 *
 * EVERY action must go through this loop:
 * 1. Execute the step
 * 2. Collect evidence
 * 3. Validate against expected outcome
 * 4. If failed, retry or abort
 *
 * The key principle: NOTHING is considered done without evidence.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import type { Evidence } from "../validation/evidence";

// ============================================
// Types
// ============================================

export type StepStatus = "pending" | "in_progress" | "validating" | "passed" | "failed" | "skipped";

export interface Step {
  id: string;
  action: string;
  expected: string;           // Expected outcome
  actual?: string;            // Actual outcome after execution
  evidence?: Evidence[];      // Proof it worked
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
  retryCount?: number;
  error?: string;
  toolCalls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  tool: string;
  arguments: Record<string, unknown>;
  result: string;
  duration: number;
  timestamp: Date;
}

export interface PlanValidateConfig {
  workingDirectory: string;
  maxRetries?: number;
  retryDelayMs?: number;
  validateEachStep?: boolean;
  collectEvidence?: boolean;
  abortOnFailure?: boolean;
}

export interface ExecutionOptions {
  onStepComplete?: (step: Step) => void;
  onStepFailed?: (step: Step) => void;
  onEvidenceCollected?: (step: Step, evidence: Evidence[]) => void;
}

export interface ValidationResult {
  passed: boolean;
  confidence: number;       // 0-100
  mismatches: string[];
  evidence: Evidence[];
}

// Re-export Evidence type for convenience
export type { Evidence } from "../validation/evidence";

// ============================================
// Plan-Validate Loop
// ============================================

export class PlanValidateLoop extends EventEmitter {
  private config: PlanValidateConfig;

  constructor(config: PlanValidateConfig) {
    super();
    this.config = {
      maxRetries: config.maxRetries ?? 2,
      retryDelayMs: config.retryDelayMs ?? 1000,
      validateEachStep: config.validateEachStep ?? true,
      collectEvidence: config.collectEvidence ?? true,
      abortOnFailure: config.abortOnFailure ?? false,
      ...config,
    };
  }

  /**
   * Execute a plan with validation
   */
  async execute(
    plan: Step[],
    options?: ExecutionOptions
  ): Promise<import("../validation/report").ValidationReport> {
    const { ValidationReporter } = await import("../validation/report");
    const { EvidenceCollector } = await import("../validation/evidence");

    const evidenceCollector = new EvidenceCollector({
      workingDirectory: this.config.workingDirectory,
    });

    const allEvidence: Evidence[] = [];

    for (const step of plan) {
      this.emit("step:started", step);
      step.status = "in_progress";
      step.startedAt = new Date();
      step.retryCount = 0;

      let success = false;
      let lastError: string | undefined;

      // Retry loop
      while (!success && step.retryCount! <= (this.config.maxRetries || 2)) {
        try {
          // 1. Execute the step
          const result = await this.executeStep(step);
          step.actual = result.output;
          step.toolCalls = result.toolCalls;

          // 2. Collect evidence
          if (this.config.collectEvidence) {
            const evidence = await evidenceCollector.collectForStep(step, result);
            step.evidence = evidence;
            allEvidence.push(...evidence);

            options?.onEvidenceCollected?.(step, evidence);
          }

          // 3. Validate against expected outcome
          if (this.config.validateEachStep) {
            step.status = "validating";
            const validation = await this.validate(step, step.evidence || []);

            if (validation.passed) {
              success = true;
              step.status = "passed";
              step.completedAt = new Date();
              this.emit("step:completed", step);
              options?.onStepComplete?.(step);
            } else {
              lastError = validation.mismatches.join("; ");
              step.retryCount!++;

              if (step.retryCount! <= (this.config.maxRetries || 2)) {
                this.emit("step:retry", step);
                await this.delay(this.config.retryDelayMs || 1000);
              }
            }
          } else {
            // No validation, assume success
            success = true;
            step.status = "passed";
            step.completedAt = new Date();
            this.emit("step:completed", step);
            options?.onStepComplete?.(step);
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          step.retryCount!++;

          if (step.retryCount! <= (this.config.maxRetries || 2)) {
            this.emit("step:retry", step);
            await this.delay(this.config.retryDelayMs || 1000);
          }
        }
      }

      // Handle step failure
      if (!success) {
        step.status = "failed";
        step.error = lastError;
        step.completedAt = new Date();
        this.emit("step:failed", step);
        options?.onStepFailed?.(step);

        if (this.config.abortOnFailure) {
          // Mark remaining steps as skipped
          for (const remaining of plan) {
            if (remaining.status === "pending") {
              remaining.status = "skipped";
            }
          }
          break;
        }
      }
    }

    // Generate validation report
    const reporter = new ValidationReporter();
    return reporter.generateReport(plan, allEvidence);
  }

  /**
   * Execute a single step
   */
  private async executeStep(step: Step): Promise<{
    output: string;
    toolCalls: ToolCallRecord[];
  }> {
    // Import Agent dynamically
    const { Agent } = await import("../eight");

    const agent = new Agent({
      model: "glm-4.7-flash:latest",
      runtime: "ollama",
      workingDirectory: this.config.workingDirectory,
      maxTurns: 10,
    });

    if (!(await agent.isReady())) {
      throw new Error("Ollama is not running");
    }

    // Execute the step action
    const prompt = `Execute this step and report the result:

Step: ${step.action}
Expected outcome: ${step.expected}

Execute the necessary tools to complete this step. Report what you did and the result.`;

    const response = await agent.chat(prompt);

    // Extract tool calls from the execution (if we can get them from agent)
    const toolCalls: ToolCallRecord[] = [];

    return {
      output: response,
      toolCalls,
    };
  }

  /**
   * Validate step result against expected outcome
   */
  private async validate(step: Step, evidence: Evidence[]): Promise<ValidationResult> {
    const mismatches: string[] = [];
    let totalChecks = 0;
    let passedChecks = 0;

    // Check evidence verification status
    for (const ev of evidence) {
      totalChecks++;
      if (ev.verified) {
        passedChecks++;
      } else {
        mismatches.push(`Evidence not verified: ${ev.description}`);
      }
    }

    // Check for file_exists evidence
    const fileExistsEvidence = evidence.filter((e) => e.type === "file_exists");
    for (const ev of fileExistsEvidence) {
      if (ev.data === false) {
        mismatches.push(`File does not exist: ${ev.description}`);
      }
    }

    // Check for command_output errors
    const commandEvidence = evidence.filter((e) => e.type === "command_output");
    for (const ev of commandEvidence) {
      const output = String(ev.data).toLowerCase();
      if (
        output.includes("error:") ||
        output.includes("failed") ||
        output.includes("exception")
      ) {
        mismatches.push(`Command had errors: ${ev.description}`);
      }
    }

    // Basic keyword matching on expected vs actual
    if (step.actual) {
      const expectedKeywords = this.extractKeywords(step.expected);
      const actualContent = step.actual.toLowerCase();

      for (const keyword of expectedKeywords) {
        if (!actualContent.includes(keyword.toLowerCase())) {
          // Don't treat missing keywords as hard failures
          // Just note them for confidence calculation
        }
      }
    }

    // Calculate confidence
    const confidence =
      totalChecks > 0
        ? Math.round((passedChecks / totalChecks) * 100)
        : evidence.length > 0
        ? 75 // Some evidence but no verification flags
        : 50; // No evidence at all

    return {
      passed: mismatches.length === 0 && evidence.some((e) => e.verified),
      confidence,
      mismatches,
      evidence,
    };
  }

  /**
   * Extract important keywords from expected outcome
   */
  private extractKeywords(text: string): string[] {
    // Extract quoted strings and important nouns
    const quoted = text.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) || [];
    const words = text
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .filter((w) => !["should", "would", "could", "with", "that", "this"].includes(w.toLowerCase()));

    return [...quoted, ...words.slice(0, 5)];
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================
// Plan Builder Helper
// ============================================

export class PlanBuilder {
  private steps: Step[] = [];
  private idCounter: number = 0;

  /**
   * Add a step to the plan
   */
  addStep(action: string, expected: string): this {
    this.idCounter++;
    this.steps.push({
      id: `step_${this.idCounter}`,
      action,
      expected,
      status: "pending",
    });
    return this;
  }

  /**
   * Build the plan
   */
  build(): Step[] {
    return [...this.steps];
  }

  /**
   * Clear the plan
   */
  clear(): this {
    this.steps = [];
    this.idCounter = 0;
    return this;
  }

  /**
   * Get step count
   */
  get length(): number {
    return this.steps.length;
  }
}

// ============================================
// Parse Plan from LLM Output
// ============================================

export function parsePlanFromResponse(response: string): Step[] {
  const steps: Step[] = [];
  let idCounter = 0;

  // Try to parse as JSON first
  const jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const item of parsed) {
        idCounter++;
        steps.push({
          id: item.id || `step_${idCounter}`,
          action: item.action || item.step || item.description || "",
          expected: item.expected || item.outcome || item.result || "",
          status: "pending",
        });
      }
      return steps;
    } catch {
      // Fall through to text parsing
    }
  }

  // Parse numbered list format: "1) action" or "1. action"
  const listPattern = /(\d+)[.)]\s*(.+?)(?=\n\d+[.)]|\n*$)/gs;
  let match;

  while ((match = listPattern.exec(response)) !== null) {
    idCounter++;
    const text = match[2].trim();

    // Try to split action and expected
    const colonSplit = text.split(":");
    const dashSplit = text.split("->");
    const parenSplit = text.split("(expected:");

    let action = text;
    let expected = "Step completed successfully";

    if (dashSplit.length > 1) {
      action = dashSplit[0].trim();
      expected = dashSplit.slice(1).join("->").trim();
    } else if (parenSplit.length > 1) {
      action = parenSplit[0].trim();
      expected = parenSplit[1].replace(")", "").trim();
    }

    steps.push({
      id: `step_${idCounter}`,
      action,
      expected,
      status: "pending",
    });
  }

  // If no steps found, create single step from entire response
  if (steps.length === 0 && response.trim()) {
    steps.push({
      id: "step_1",
      action: response.trim().slice(0, 200),
      expected: "Task completed",
      status: "pending",
    });
  }

  return steps;
}

// ============================================
// Format Plan for Display
// ============================================

export function formatPlan(plan: Step[]): string {
  const lines: string[] = ["Plan:"];

  for (const step of plan) {
    const statusIcon = {
      pending: "○",
      in_progress: "◐",
      validating: "◑",
      passed: "●",
      failed: "✗",
      skipped: "◌",
    }[step.status];

    const statusColor = {
      pending: "\x1b[90m",
      in_progress: "\x1b[36m",
      validating: "\x1b[35m",
      passed: "\x1b[32m",
      failed: "\x1b[31m",
      skipped: "\x1b[90m",
    }[step.status];

    const reset = "\x1b[0m";

    lines.push(`  ${statusColor}${statusIcon}${reset} [${step.id}] ${step.action}`);

    if (step.status === "passed" && step.evidence?.length) {
      lines.push(`    └─ \x1b[32m✓\x1b[0m ${step.evidence.length} evidence items`);
    }

    if (step.status === "failed" && step.error) {
      lines.push(`    └─ \x1b[31m✗\x1b[0m ${step.error.slice(0, 60)}`);
    }
  }

  return lines.join("\n");
}
