/**
 * 8gent Code - Completion Report Generator
 *
 * Generates beautifully formatted completion summaries like Claude Code.
 * Tracks files created/modified, tools used, duration, and provides evidence of completion.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type CompletionReport,
  type TaskContext,
  type StepSummary,
  type EvidenceSummary,
  type FileOperation,
  type ToolInvocation,
  type StoredReport,
} from "./types";
import {
  box,
  colors,
  colorize,
  bold,
  muted,
  success,
  warning,
  error,
  info,
  divider,
  doubleDivider,
  heading,
  list,
  numberedList,
  tree,
  statusLine,
  statusIcon,
  stepIcon,
  formatDuration,
  formatNumber,
  boxChars,
  type TreeItem,
} from "./formatter";

// ============================================
// Completion Reporter Class
// ============================================

export class CompletionReporter {
  private reportsDir: string;

  constructor(reportsDir?: string) {
    this.reportsDir = reportsDir || path.join(os.homedir(), ".8gent", "reports");
    this.ensureReportsDir();
  }

  private ensureReportsDir(): void {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  // ============================================
  // Generate Report from Task Context
  // ============================================

  generateReport(context: TaskContext): CompletionReport {
    const endTime = context.endTime || Date.now();
    const durationMs = endTime - context.startTime;

    // Extract files created and modified
    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    const filesDeleted: string[] = [];
    const seenFiles = new Set<string>();

    for (const op of context.fileOperations) {
      if (seenFiles.has(op.path)) continue;
      seenFiles.add(op.path);

      if (op.type === "create") {
        filesCreated.push(op.path);
      } else if (op.type === "modify") {
        filesModified.push(op.path);
      } else if (op.type === "delete") {
        filesDeleted.push(op.path);
      }
    }

    // Generate step summaries
    const steps: StepSummary[] = context.steps.map((step, index) => ({
      index: index + 1,
      description: step.description,
      status: step.status,
      duration: step.endTime ? step.endTime - step.startTime : undefined,
      toolsUsed: step.tools.map(t => t.name),
      filesAffected: step.files.map(f => f.path),
      error: step.error,
    }));

    // Generate evidence
    const evidence = this.generateEvidence(context, filesCreated, filesModified);

    // Calculate confidence
    const confidence = this.calculateConfidence(context, evidence);

    // Determine status
    const hasErrors = context.steps.some(s => s.status === "failed");
    const allCompleted = context.steps.every(s => s.status === "completed" || s.status === "skipped");
    const status: CompletionReport["status"] = hasErrors
      ? (allCompleted ? "partial" : "failed")
      : "success";

    // Generate summary
    const summary = this.generateSummary(context, filesCreated, filesModified);

    const report: CompletionReport = {
      id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskId: context.taskId,
      summary,
      detailedSummary: context.taskDescription,
      filesCreated,
      filesModified,
      filesDeleted,
      toolsUsed: context.tools.length,
      tokensUsed: context.tokensUsed,
      tokensSaved: context.tokensSaved,
      duration: formatDuration(durationMs),
      durationMs,
      steps,
      evidence,
      gitCommit: context.gitCommits?.[0],
      gitBranch: context.gitBranch,
      confidence,
      startedAt: new Date(context.startTime),
      completedAt: new Date(endTime),
      workingDirectory: context.workingDirectory,
      error: context.error,
      status,
    };

    return report;
  }

  private generateSummary(
    context: TaskContext,
    filesCreated: string[],
    filesModified: string[]
  ): string {
    const parts: string[] = [];

    // Count completed steps
    const completedSteps = context.steps.filter(s => s.status === "completed").length;

    if (completedSteps > 0) {
      parts.push(`Completed ${completedSteps} step${completedSteps > 1 ? "s" : ""}`);
    }

    if (filesCreated.length > 0) {
      parts.push(`created ${filesCreated.length} file${filesCreated.length > 1 ? "s" : ""}`);
    }

    if (filesModified.length > 0) {
      parts.push(`modified ${filesModified.length} file${filesModified.length > 1 ? "s" : ""}`);
    }

    if (context.gitCommits && context.gitCommits.length > 0) {
      parts.push(`committed to git`);
    }

    if (parts.length === 0) {
      return context.taskDescription;
    }

    return parts.join(", ") + ".";
  }

  private generateEvidence(
    context: TaskContext,
    filesCreated: string[],
    filesModified: string[]
  ): EvidenceSummary[] {
    const evidence: EvidenceSummary[] = [];

    // Check files exist
    const allFiles = [...filesCreated, ...filesModified];
    const existingFiles = allFiles.filter(f => {
      const fullPath = path.isAbsolute(f) ? f : path.join(context.workingDirectory, f);
      return fs.existsSync(fullPath);
    });

    evidence.push({
      type: "files_exist",
      label: `Files exist`,
      status: existingFiles.length === allFiles.length ? "pass" : "fail",
      details: `${existingFiles.length}/${allFiles.length}`,
    });

    // Check for git commit
    if (context.gitCommits && context.gitCommits.length > 0) {
      evidence.push({
        type: "git_committed",
        label: "Git committed",
        status: "pass",
        details: context.gitCommits[0].slice(0, 7),
      });
    }

    // Check for build (if package.json exists)
    const packageJsonPath = path.join(context.workingDirectory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      // We don't actually run the build, just note it's available
      evidence.push({
        type: "build_passes",
        label: "Build available",
        status: "pending",
        details: "npm run build",
      });
    }

    return evidence;
  }

  private calculateConfidence(context: TaskContext, evidence: EvidenceSummary[]): number {
    let score = 0;
    let maxScore = 0;

    // Steps completion (50 points max)
    const completedSteps = context.steps.filter(s => s.status === "completed").length;
    const totalSteps = context.steps.length;
    if (totalSteps > 0) {
      score += (completedSteps / totalSteps) * 50;
      maxScore += 50;
    }

    // Evidence (30 points max)
    const passedEvidence = evidence.filter(e => e.status === "pass").length;
    const totalEvidence = evidence.length;
    if (totalEvidence > 0) {
      score += (passedEvidence / totalEvidence) * 30;
      maxScore += 30;
    }

    // No errors (20 points)
    if (!context.error && !context.steps.some(s => s.status === "failed")) {
      score += 20;
    }
    maxScore += 20;

    return maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  }

  // ============================================
  // Format for Terminal
  // ============================================

  formatForTerminal(report: CompletionReport): string {
    const lines: string[] = [];

    // Status banner
    const statusText = report.status === "success"
      ? `${colors.success}${colors.bold}  ${boxChars.checkmark} TASK COMPLETE${colors.reset}`
      : report.status === "partial"
      ? `${colors.warning}${colors.bold}  ${boxChars.checkmark} PARTIALLY COMPLETE${colors.reset}`
      : `${colors.error}${colors.bold}  ${boxChars.crossmark} TASK FAILED${colors.reset}`;

    lines.push(box(statusText, {
      style: "double",
      width: 64,
      align: "center",
      borderColor: report.status === "success" ? "success" : report.status === "partial" ? "warning" : "error",
    }));
    lines.push("");

    // Summary section
    lines.push(heading("Summary", 2));
    const summaryLines = this.wrapTextToWidth(report.summary, 60);
    for (const line of summaryLines) {
      lines.push(`  ${line}`);
    }
    lines.push("");

    // Files Created section
    if (report.filesCreated.length > 0) {
      lines.push(heading(`Files Created (${report.filesCreated.length})`, 2));
      for (const file of report.filesCreated) {
        lines.push(`  ${success(boxChars.bullet)} ${file}`);
      }
      lines.push("");
    }

    // Files Modified section
    if (report.filesModified.length > 0) {
      lines.push(heading(`Files Modified (${report.filesModified.length})`, 2));
      for (const file of report.filesModified) {
        lines.push(`  ${warning(boxChars.bullet)} ${file}`);
      }
      lines.push("");
    }

    // Files Deleted section
    if (report.filesDeleted.length > 0) {
      lines.push(heading(`Files Deleted (${report.filesDeleted.length})`, 2));
      for (const file of report.filesDeleted) {
        lines.push(`  ${error(boxChars.bullet)} ${file}`);
      }
      lines.push("");
    }

    // Steps Taken section
    if (report.steps.length > 0) {
      lines.push(heading("Steps Taken", 2));
      for (const step of report.steps) {
        const icon = stepIcon(step.status);
        const duration = step.duration ? muted(` (${formatDuration(step.duration)})`) : "";
        lines.push(`  ${step.index}. ${icon} ${step.description}${duration}`);
      }
      lines.push("");
    }

    // Evidence section
    if (report.evidence.length > 0) {
      lines.push(heading("Evidence", 2));
      const evidenceTree: TreeItem[] = report.evidence.map(e => ({
        label: `${e.label}: ${statusIcon(e.status)}${e.details ? ` ${e.details}` : ""}${e.url ? ` ${info(e.url)}` : ""}`,
      }));
      lines.push(tree(evidenceTree));
      lines.push("");
    }

    // Stats section
    lines.push(heading("Stats", 2));
    lines.push(`  ${statusLine("Tools used", String(report.toolsUsed), "info")}`);
    lines.push(`  ${statusLine("Duration", report.duration, "warning")}`);
    lines.push(`  ${statusLine("Confidence", `${report.confidence}%`, report.confidence >= 80 ? "success" : report.confidence >= 50 ? "warning" : "error")}`);
    if (report.tokensUsed) {
      lines.push(`  ${statusLine("Tokens used", formatNumber(report.tokensUsed), "muted")}`);
    }
    if (report.tokensSaved) {
      lines.push(`  ${statusLine("Tokens saved", formatNumber(report.tokensSaved), "success")}`);
    }
    if (report.gitBranch) {
      lines.push(`  ${statusLine("Branch", report.gitBranch, "warning")}`);
    }
    lines.push("");

    // Divider
    lines.push(divider(boxChars.singleHorizontal, 64));

    return lines.join("\n");
  }

  private wrapTextToWidth(text: string, width: number): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (testLine.length <= width) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  // ============================================
  // Format as Markdown
  // ============================================

  formatAsMarkdown(report: CompletionReport): string {
    const lines: string[] = [];

    // Header
    const statusEmoji = report.status === "success" ? "check" : report.status === "partial" ? "warning" : "x";
    lines.push(`# :${statusEmoji}: Task Complete`);
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push(report.summary);
    lines.push("");

    // Files Created
    if (report.filesCreated.length > 0) {
      lines.push(`## Files Created (${report.filesCreated.length})`);
      for (const file of report.filesCreated) {
        lines.push(`- \`${file}\``);
      }
      lines.push("");
    }

    // Files Modified
    if (report.filesModified.length > 0) {
      lines.push(`## Files Modified (${report.filesModified.length})`);
      for (const file of report.filesModified) {
        lines.push(`- \`${file}\``);
      }
      lines.push("");
    }

    // Steps Taken
    if (report.steps.length > 0) {
      lines.push("## Steps Taken");
      for (const step of report.steps) {
        const statusIcon = step.status === "completed" ? ":white_check_mark:" : step.status === "failed" ? ":x:" : ":hourglass:";
        const duration = step.duration ? ` _(${formatDuration(step.duration)})_` : "";
        lines.push(`${step.index}. ${statusIcon} ${step.description}${duration}`);
      }
      lines.push("");
    }

    // Evidence
    if (report.evidence.length > 0) {
      lines.push("## Evidence");
      for (const e of report.evidence) {
        const statusIcon = e.status === "pass" ? ":white_check_mark:" : e.status === "fail" ? ":x:" : ":hourglass:";
        const details = e.details ? ` ${e.details}` : "";
        const url = e.url ? ` [link](${e.url})` : "";
        lines.push(`- ${statusIcon} **${e.label}**${details}${url}`);
      }
      lines.push("");
    }

    // Stats
    lines.push("## Stats");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Tools used | ${report.toolsUsed} |`);
    lines.push(`| Duration | ${report.duration} |`);
    lines.push(`| Confidence | ${report.confidence}% |`);
    if (report.tokensUsed) {
      lines.push(`| Tokens used | ${formatNumber(report.tokensUsed)} |`);
    }
    if (report.tokensSaved) {
      lines.push(`| Tokens saved | ${formatNumber(report.tokensSaved)} |`);
    }
    if (report.gitBranch) {
      lines.push(`| Branch | ${report.gitBranch} |`);
    }
    if (report.gitCommit) {
      lines.push(`| Commit | \`${report.gitCommit.slice(0, 7)}\` |`);
    }
    lines.push("");

    // Metadata
    lines.push("---");
    lines.push(`_Generated at ${report.completedAt.toISOString()}_`);
    lines.push(`_Working directory: \`${report.workingDirectory}\`_`);

    return lines.join("\n");
  }

  // ============================================
  // Storage Functions
  // ============================================

  saveReport(report: CompletionReport): string {
    const storedReport: StoredReport = {
      ...report,
      version: 1,
      storedAt: new Date(),
    };

    const filename = `${report.id}.json`;
    const filepath = path.join(this.reportsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(storedReport, null, 2));

    return filepath;
  }

  loadReport(reportId: string): CompletionReport | null {
    const filepath = path.join(this.reportsDir, `${reportId}.json`);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    const content = fs.readFileSync(filepath, "utf-8");
    const report = JSON.parse(content) as StoredReport;

    // Convert date strings back to Date objects
    report.startedAt = new Date(report.startedAt);
    report.completedAt = new Date(report.completedAt);
    report.storedAt = new Date(report.storedAt);

    return report;
  }

  listReports(options: { limit?: number; status?: CompletionReport["status"] } = {}): CompletionReport[] {
    const { limit = 20, status } = options;

    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a)); // Newest first

    const reports: CompletionReport[] = [];

    for (const file of files) {
      if (reports.length >= limit) break;

      const filepath = path.join(this.reportsDir, file);
      const content = fs.readFileSync(filepath, "utf-8");
      const report = JSON.parse(content) as StoredReport;

      // Convert dates
      report.startedAt = new Date(report.startedAt);
      report.completedAt = new Date(report.completedAt);
      report.storedAt = new Date(report.storedAt);

      if (!status || report.status === status) {
        reports.push(report);
      }
    }

    return reports;
  }

  deleteReport(reportId: string): boolean {
    const filepath = path.join(this.reportsDir, `${reportId}.json`);

    if (!fs.existsSync(filepath)) {
      return false;
    }

    fs.unlinkSync(filepath);
    return true;
  }

  getReportsDir(): string {
    return this.reportsDir;
  }
}

// ============================================
// Task Context Tracker
// ============================================

export class TaskContextTracker {
  private context: TaskContext;
  private currentStep: number = -1;

  constructor(taskId: string, taskDescription: string, workingDirectory: string = process.cwd()) {
    this.context = {
      taskId,
      taskDescription,
      startTime: Date.now(),
      workingDirectory,
      steps: [],
      tools: [],
      fileOperations: [],
    };
  }

  startStep(description: string): number {
    this.currentStep = this.context.steps.length;
    this.context.steps.push({
      index: this.currentStep,
      description,
      startTime: Date.now(),
      tools: [],
      files: [],
      status: "running",
    });
    return this.currentStep;
  }

  completeStep(stepIndex?: number): void {
    const idx = stepIndex ?? this.currentStep;
    if (idx >= 0 && idx < this.context.steps.length) {
      this.context.steps[idx].endTime = Date.now();
      this.context.steps[idx].status = "completed";
    }
  }

  failStep(error: string, stepIndex?: number): void {
    const idx = stepIndex ?? this.currentStep;
    if (idx >= 0 && idx < this.context.steps.length) {
      this.context.steps[idx].endTime = Date.now();
      this.context.steps[idx].status = "failed";
      this.context.steps[idx].error = error;
    }
  }

  skipStep(stepIndex?: number): void {
    const idx = stepIndex ?? this.currentStep;
    if (idx >= 0 && idx < this.context.steps.length) {
      this.context.steps[idx].endTime = Date.now();
      this.context.steps[idx].status = "skipped";
    }
  }

  recordTool(invocation: ToolInvocation): void {
    this.context.tools.push(invocation);

    // Also add to current step if there is one
    if (this.currentStep >= 0 && this.currentStep < this.context.steps.length) {
      this.context.steps[this.currentStep].tools.push(invocation);
    }
  }

  recordFileOperation(operation: FileOperation): void {
    this.context.fileOperations.push(operation);

    // Also add to current step if there is one
    if (this.currentStep >= 0 && this.currentStep < this.context.steps.length) {
      this.context.steps[this.currentStep].files.push(operation);
    }
  }

  setGitBranch(branch: string): void {
    this.context.gitBranch = branch;
  }

  addGitCommit(commitHash: string): void {
    if (!this.context.gitCommits) {
      this.context.gitCommits = [];
    }
    this.context.gitCommits.push(commitHash);
  }

  setTokensUsed(tokens: number): void {
    this.context.tokensUsed = tokens;
  }

  setTokensSaved(tokens: number): void {
    this.context.tokensSaved = tokens;
  }

  setModel(model: string): void {
    this.context.model = model;
  }

  setResult(result: string): void {
    this.context.result = result;
  }

  setError(error: string): void {
    this.context.error = error;
  }

  complete(): TaskContext {
    this.context.endTime = Date.now();
    return this.context;
  }

  getContext(): TaskContext {
    return this.context;
  }
}

// ============================================
// Exports
// ============================================

export function createReporter(reportsDir?: string): CompletionReporter {
  return new CompletionReporter(reportsDir);
}

export function createTracker(
  taskId: string,
  taskDescription: string,
  workingDirectory?: string
): TaskContextTracker {
  return new TaskContextTracker(taskId, taskDescription, workingDirectory);
}

// Singleton instance
let defaultReporter: CompletionReporter | null = null;

export function getCompletionReporter(): CompletionReporter {
  if (!defaultReporter) {
    defaultReporter = new CompletionReporter();
  }
  return defaultReporter;
}
