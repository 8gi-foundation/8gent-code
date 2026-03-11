/**
 * 8gent Code - Validation Report
 *
 * Generates comprehensive reports showing what was done,
 * the evidence collected, and confidence levels.
 */

import type { Step } from "../workflow/plan-validate";
import type { Evidence, EvidenceType } from "./evidence";
import { summarizeEvidence } from "./evidence";

// ============================================
// Types
// ============================================

export interface ValidationReport {
  planId: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  evidence: Evidence[];
  summary: string;
  confidence: number;  // 0-100% confidence the task succeeded
  timestamp: Date;
  duration?: number;   // Total execution duration in ms
  steps: StepReport[];
  warnings: string[];
  suggestions: string[];
}

export interface StepReport {
  stepId: string;
  action: string;
  expected: string;
  actual?: string;
  status: "passed" | "failed" | "skipped" | "pending";
  evidence: Evidence[];
  confidence: number;
  duration?: number;
  error?: string;
}

export interface ReportDisplayOptions {
  showEvidence?: boolean;
  showTimings?: boolean;
  colorize?: boolean;
  maxWidth?: number;
  compact?: boolean;
}

// ============================================
// Validation Reporter
// ============================================

export class ValidationReporter {
  private idCounter: number = 0;

  /**
   * Generate a validation report from executed plan
   */
  generateReport(plan: Step[], evidence: Evidence[]): ValidationReport {
    this.idCounter++;
    const planId = `plan_${Date.now()}_${this.idCounter}`;

    const steps = plan.map((step) => this.createStepReport(step));
    const passedSteps = steps.filter((s) => s.status === "passed").length;
    const failedSteps = steps.filter((s) => s.status === "failed").length;
    const skippedSteps = steps.filter((s) => s.status === "skipped").length;

    // Calculate overall confidence
    const confidence = this.calculateConfidence(steps, evidence);

    // Generate summary
    const summary = this.generateSummary(steps, evidence, confidence);

    // Collect warnings and suggestions
    const { warnings, suggestions } = this.analyzeResults(steps, evidence);

    // Calculate total duration
    const duration = plan.reduce((total, step) => {
      if (step.startedAt && step.completedAt) {
        return total + (step.completedAt.getTime() - step.startedAt.getTime());
      }
      return total;
    }, 0);

    return {
      planId,
      totalSteps: plan.length,
      passedSteps,
      failedSteps,
      skippedSteps,
      evidence,
      summary,
      confidence,
      timestamp: new Date(),
      duration,
      steps,
      warnings,
      suggestions,
    };
  }

  /**
   * Create a step report
   */
  private createStepReport(step: Step): StepReport {
    const status =
      step.status === "passed"
        ? "passed"
        : step.status === "failed"
        ? "failed"
        : step.status === "skipped"
        ? "skipped"
        : "pending";

    const stepEvidence = step.evidence || [];
    const verifiedCount = stepEvidence.filter((e) => e.verified).length;
    const confidence =
      stepEvidence.length > 0
        ? Math.round((verifiedCount / stepEvidence.length) * 100)
        : status === "passed"
        ? 75
        : status === "failed"
        ? 0
        : 50;

    const duration =
      step.startedAt && step.completedAt
        ? step.completedAt.getTime() - step.startedAt.getTime()
        : undefined;

    return {
      stepId: step.id,
      action: step.action,
      expected: step.expected,
      actual: step.actual,
      status,
      evidence: stepEvidence,
      confidence,
      duration,
      error: step.error,
    };
  }

  /**
   * Calculate overall confidence score
   */
  private calculateConfidence(steps: StepReport[], evidence: Evidence[]): number {
    if (steps.length === 0) return 0;

    // Factors that affect confidence:
    // 1. Percentage of passed steps
    // 2. Percentage of verified evidence
    // 3. Absence of critical failures
    // 4. Quality of evidence (file_exists vs just command_output)

    const passedRatio = steps.filter((s) => s.status === "passed").length / steps.length;
    const verifiedRatio =
      evidence.length > 0
        ? evidence.filter((e) => e.verified).length / evidence.length
        : 0;

    // Weight evidence types
    const evidenceQuality = this.calculateEvidenceQuality(evidence);

    // Check for critical failures
    const hasCriticalFailure = steps.some(
      (s) => s.status === "failed" && s.error?.toLowerCase().includes("fatal")
    );

    // Calculate weighted confidence
    let confidence =
      passedRatio * 40 +       // 40% weight on step completion
      verifiedRatio * 30 +     // 30% weight on evidence verification
      evidenceQuality * 30;    // 30% weight on evidence quality

    // Penalty for critical failures
    if (hasCriticalFailure) {
      confidence *= 0.5;
    }

    // Penalty for no evidence
    if (evidence.length === 0) {
      confidence *= 0.6;
    }

    return Math.round(Math.max(0, Math.min(100, confidence)));
  }

  /**
   * Calculate evidence quality score (0-1)
   */
  private calculateEvidenceQuality(evidence: Evidence[]): number {
    if (evidence.length === 0) return 0;

    // Weight different evidence types
    const weights: Record<EvidenceType, number> = {
      file_exists: 0.9,
      file_content: 0.95,
      test_result: 1.0,
      git_commit: 0.85,
      diff: 0.8,
      command_output: 0.6,
      git_status: 0.7,
      directory_listing: 0.75,
      json_content: 0.9,
      screenshot: 0.85,
      error_log: 0.3,
    };

    const totalWeight = evidence.reduce((sum, e) => {
      const weight = weights[e.type] || 0.5;
      return sum + (e.verified ? weight : weight * 0.3);
    }, 0);

    return totalWeight / evidence.length;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    steps: StepReport[],
    evidence: Evidence[],
    confidence: number
  ): string {
    const passed = steps.filter((s) => s.status === "passed").length;
    const failed = steps.filter((s) => s.status === "failed").length;
    const total = steps.length;

    const evidenceSummary = summarizeEvidence(evidence);

    let summary = "";

    if (confidence >= 90) {
      summary = `Task completed successfully. `;
    } else if (confidence >= 70) {
      summary = `Task completed with high confidence. `;
    } else if (confidence >= 50) {
      summary = `Task completed with moderate confidence. `;
    } else {
      summary = `Task completed with low confidence. `;
    }

    summary += `${passed}/${total} steps passed. `;

    if (failed > 0) {
      summary += `${failed} step${failed > 1 ? "s" : ""} failed. `;
    }

    summary += `${evidenceSummary.verified}/${evidenceSummary.total} evidence items verified. `;
    summary += `Overall confidence: ${confidence}%.`;

    return summary;
  }

  /**
   * Analyze results for warnings and suggestions
   */
  private analyzeResults(
    steps: StepReport[],
    evidence: Evidence[]
  ): { warnings: string[]; suggestions: string[] } {
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // Check for failed steps
    const failedSteps = steps.filter((s) => s.status === "failed");
    for (const step of failedSteps) {
      warnings.push(`Step "${step.stepId}" failed: ${step.error || "Unknown error"}`);
    }

    // Check for unverified evidence
    const unverifiedEvidence = evidence.filter((e) => !e.verified);
    if (unverifiedEvidence.length > 0) {
      warnings.push(`${unverifiedEvidence.length} evidence items could not be verified`);
    }

    // Check for missing evidence types
    const evidenceTypes = new Set(evidence.map((e) => e.type));
    if (!evidenceTypes.has("file_exists") && !evidenceTypes.has("file_content")) {
      suggestions.push("Consider adding file existence checks for better verification");
    }
    if (!evidenceTypes.has("test_result")) {
      suggestions.push("Running tests would increase confidence in the results");
    }

    // Check for error patterns in command output
    const errorEvidence = evidence.filter(
      (e) =>
        e.type === "command_output" &&
        typeof e.data === "string" &&
        e.data.toLowerCase().includes("error")
    );
    if (errorEvidence.length > 0) {
      warnings.push("Some commands produced error output - review the evidence");
    }

    // Low evidence count warning
    if (evidence.length < steps.length) {
      suggestions.push(
        "Evidence count is low - consider collecting more proof of success"
      );
    }

    return { warnings, suggestions };
  }

  /**
   * Format report for terminal display
   */
  formatForDisplay(report: ValidationReport, options?: ReportDisplayOptions): string {
    const opts: Required<ReportDisplayOptions> = {
      showEvidence: options?.showEvidence ?? true,
      showTimings: options?.showTimings ?? true,
      colorize: options?.colorize ?? true,
      maxWidth: options?.maxWidth ?? 80,
      compact: options?.compact ?? false,
    };

    const lines: string[] = [];
    const c = opts.colorize;

    // Header
    lines.push(this.colorize("═".repeat(opts.maxWidth!), "cyan", c));
    lines.push(this.colorize("  VALIDATION REPORT", "cyan", c));
    lines.push(this.colorize("═".repeat(opts.maxWidth!), "cyan", c));
    lines.push("");

    // Summary
    lines.push(this.colorize("Summary:", "bold", c));
    lines.push(`  ${report.summary}`);
    lines.push("");

    // Confidence meter
    const confidenceColor =
      report.confidence >= 80 ? "green" : report.confidence >= 50 ? "yellow" : "red";
    const confidenceBar = this.createProgressBar(report.confidence, 30);
    lines.push(
      `  Confidence: ${this.colorize(`${report.confidence}%`, confidenceColor, c)} ${confidenceBar}`
    );
    lines.push("");

    // Steps
    lines.push(this.colorize("Steps:", "bold", c));
    for (const step of report.steps) {
      const statusIcon =
        step.status === "passed"
          ? this.colorize("✓", "green", c)
          : step.status === "failed"
          ? this.colorize("✗", "red", c)
          : this.colorize("○", "gray", c);

      const timing = opts.showTimings && step.duration ? ` (${step.duration}ms)` : "";

      lines.push(`  ${statusIcon} [${step.stepId}] ${step.action.slice(0, 50)}${timing}`);

      if (step.status === "failed" && step.error && !opts.compact) {
        lines.push(`     └─ ${this.colorize(step.error.slice(0, 60), "red", c)}`);
      }

      if (opts.showEvidence && step.evidence.length > 0 && !opts.compact) {
        const verified = step.evidence.filter((e) => e.verified).length;
        lines.push(
          `     └─ ${verified}/${step.evidence.length} evidence items verified`
        );
      }
    }
    lines.push("");

    // Evidence Summary
    if (opts.showEvidence && report.evidence.length > 0) {
      lines.push(this.colorize("Evidence:", "bold", c));
      const summary = summarizeEvidence(report.evidence);

      for (const [type, count] of Object.entries(summary.byType)) {
        const typeEvidence = report.evidence.filter((e) => e.type === type);
        const verified = typeEvidence.filter((e) => e.verified).length;
        const icon = verified === count ? this.colorize("✓", "green", c) : this.colorize("◐", "yellow", c);
        lines.push(`  ${icon} ${type}: ${verified}/${count} verified`);
      }
      lines.push("");
    }

    // Warnings
    if (report.warnings.length > 0) {
      lines.push(this.colorize("Warnings:", "yellow", c));
      for (const warning of report.warnings) {
        lines.push(`  ⚠ ${warning}`);
      }
      lines.push("");
    }

    // Suggestions
    if (report.suggestions.length > 0 && !opts.compact) {
      lines.push(this.colorize("Suggestions:", "cyan", c));
      for (const suggestion of report.suggestions) {
        lines.push(`  💡 ${suggestion}`);
      }
      lines.push("");
    }

    // Footer
    if (opts.showTimings && report.duration) {
      lines.push(
        this.colorize(
          `Total duration: ${(report.duration / 1000).toFixed(1)}s`,
          "gray",
          c
        )
      );
    }
    lines.push(this.colorize("─".repeat(opts.maxWidth!), "gray", c));

    return lines.join("\n");
  }

  /**
   * Export report as JSON
   */
  exportAsJson(report: ValidationReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Export report as Markdown
   */
  exportAsMarkdown(report: ValidationReport): string {
    const lines: string[] = [];

    lines.push("# Validation Report");
    lines.push("");
    lines.push(`**Plan ID:** ${report.planId}`);
    lines.push(`**Timestamp:** ${report.timestamp.toISOString()}`);
    lines.push(`**Confidence:** ${report.confidence}%`);
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push(report.summary);
    lines.push("");

    lines.push("## Steps");
    lines.push("");
    lines.push("| Step | Action | Status | Confidence |");
    lines.push("|------|--------|--------|------------|");

    for (const step of report.steps) {
      const status = step.status === "passed" ? "✅" : step.status === "failed" ? "❌" : "⏭️";
      lines.push(
        `| ${step.stepId} | ${step.action.slice(0, 40)}... | ${status} | ${step.confidence}% |`
      );
    }
    lines.push("");

    lines.push("## Evidence");
    lines.push("");
    lines.push(`Total: ${report.evidence.length} items`);
    lines.push("");

    const summary = summarizeEvidence(report.evidence);
    for (const [type, count] of Object.entries(summary.byType)) {
      lines.push(`- **${type}:** ${count} items`);
    }
    lines.push("");

    if (report.warnings.length > 0) {
      lines.push("## Warnings");
      lines.push("");
      for (const warning of report.warnings) {
        lines.push(`- ⚠️ ${warning}`);
      }
      lines.push("");
    }

    if (report.suggestions.length > 0) {
      lines.push("## Suggestions");
      lines.push("");
      for (const suggestion of report.suggestions) {
        lines.push(`- 💡 ${suggestion}`);
      }
    }

    return lines.join("\n");
  }

  // ============================================
  // Helper Methods
  // ============================================

  private colorize(text: string, color: string, enabled: boolean): string {
    if (!enabled) return text;

    const colors: Record<string, string> = {
      green: "\x1b[32m",
      red: "\x1b[31m",
      yellow: "\x1b[33m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
      bold: "\x1b[1m",
    };

    const code = colors[color] || "";
    return code ? `${code}${text}\x1b[0m` : text;
  }

  private createProgressBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  }
}

// ============================================
// Export Singleton
// ============================================

let reporterInstance: ValidationReporter | null = null;

export function getValidationReporter(): ValidationReporter {
  if (!reporterInstance) {
    reporterInstance = new ValidationReporter();
  }
  return reporterInstance;
}
