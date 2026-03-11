/**
 * 8gent Code - Agent Reporting Integration
 *
 * Integrates the completion reporting system with the Agent.
 * Tracks tool invocations, file operations, and generates completion reports.
 */

import * as path from "path";
import {
  type CompletionReport,
  type TaskContext,
  type ToolInvocation,
  type FileOperation,
} from "./types";
import {
  CompletionReporter,
  TaskContextTracker,
  getCompletionReporter,
} from "./completion";
import {
  getReportHistory,
  handleReportsCommand,
  handleReportCommand,
} from "./history";

// ============================================
// Agent Reporting Wrapper
// ============================================

/**
 * Wraps agent execution with reporting capabilities.
 * Tracks all tool invocations and file operations to generate completion reports.
 */
export class AgentReportingContext {
  private tracker: TaskContextTracker;
  private reporter: CompletionReporter;
  private currentStepIndex: number = -1;
  private toolCount: number = 0;

  constructor(
    taskDescription: string,
    workingDirectory: string = process.cwd(),
    model?: string
  ) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.tracker = new TaskContextTracker(taskId, taskDescription, workingDirectory);
    this.reporter = getCompletionReporter();

    if (model) {
      this.tracker.setModel(model);
    }
  }

  // ============================================
  // Step Management
  // ============================================

  startStep(description: string): number {
    this.currentStepIndex = this.tracker.startStep(description);
    return this.currentStepIndex;
  }

  completeStep(): void {
    this.tracker.completeStep(this.currentStepIndex);
  }

  failStep(error: string): void {
    this.tracker.failStep(error, this.currentStepIndex);
  }

  skipStep(): void {
    this.tracker.skipStep(this.currentStepIndex);
  }

  // ============================================
  // Tool Tracking
  // ============================================

  recordToolStart(name: string, args: Record<string, unknown>): number {
    this.toolCount++;
    return Date.now();
  }

  recordToolEnd(
    name: string,
    args: Record<string, unknown>,
    result: string,
    startTime: number,
    success: boolean = true
  ): void {
    const invocation: ToolInvocation = {
      name,
      arguments: args,
      result: result.slice(0, 1000), // Truncate result
      duration: Date.now() - startTime,
      timestamp: startTime,
      success,
    };

    this.tracker.recordTool(invocation);

    // Track file operations based on tool name
    this.extractFileOperations(name, args, result);
  }

  private extractFileOperations(
    toolName: string,
    args: Record<string, unknown>,
    result: string
  ): void {
    const filePath = (args.path as string) || (args.filePath as string);

    if (!filePath) return;

    let operation: FileOperation | null = null;

    switch (toolName) {
      case "write_file":
        // Check if file was created or modified based on result
        if (result.includes("File written:")) {
          operation = {
            type: result.includes("created") ? "create" : "modify",
            path: filePath,
            timestamp: Date.now(),
          };
        }
        break;

      case "edit_file":
        if (result.includes("File edited:")) {
          operation = {
            type: "modify",
            path: filePath,
            timestamp: Date.now(),
          };
        }
        break;

      case "read_file":
        operation = {
          type: "read",
          path: filePath,
          timestamp: Date.now(),
        };
        break;

      case "run_command":
        // Check for file operations in commands
        const command = args.command as string;
        if (command?.includes("rm ") || command?.includes("rm -")) {
          // Extract deleted files - basic heuristic
          const files = command.match(/rm\s+(-\w+\s+)?(.+)/)?.[2]?.split(/\s+/);
          if (files) {
            for (const file of files) {
              if (file && !file.startsWith("-")) {
                this.tracker.recordFileOperation({
                  type: "delete",
                  path: file,
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
        break;
    }

    if (operation) {
      this.tracker.recordFileOperation(operation);
    }
  }

  // ============================================
  // Git Tracking
  // ============================================

  setGitBranch(branch: string): void {
    this.tracker.setGitBranch(branch);
  }

  addGitCommit(commitHash: string): void {
    this.tracker.addGitCommit(commitHash);
  }

  // ============================================
  // Metrics
  // ============================================

  setTokensUsed(tokens: number): void {
    this.tracker.setTokensUsed(tokens);
  }

  setTokensSaved(tokens: number): void {
    this.tracker.setTokensSaved(tokens);
  }

  // ============================================
  // Completion
  // ============================================

  setResult(result: string): void {
    this.tracker.setResult(result);
  }

  setError(error: string): void {
    this.tracker.setError(error);
  }

  /**
   * Complete the task and generate a report.
   * Returns the formatted report and saves it to disk.
   */
  complete(options: { display?: boolean; save?: boolean } = {}): CompletionReport {
    const { display = true, save = true } = options;

    const context = this.tracker.complete();
    const report = this.reporter.generateReport(context);

    if (save) {
      this.reporter.saveReport(report);
    }

    if (display) {
      console.log("\n" + this.reporter.formatForTerminal(report));
    }

    return report;
  }

  getContext(): TaskContext {
    return this.tracker.getContext();
  }

  getToolCount(): number {
    return this.toolCount;
  }
}

// ============================================
// REPL Command Handlers
// ============================================

/**
 * Handle /reports command
 */
export function handleReports(args: string[]): string {
  const history = getReportHistory();
  return handleReportsCommand(history, args);
}

/**
 * Handle /report <id> command
 */
export function handleReport(reportId: string): string {
  const history = getReportHistory();
  return handleReportCommand(history, reportId);
}

/**
 * Check if a command is a report command
 */
export function isReportCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return trimmed === "/reports" ||
    trimmed.startsWith("/reports ") ||
    trimmed.startsWith("/report ");
}

/**
 * Parse and handle report commands
 * Returns the response string or null if not a report command
 */
export function handleReportCommands(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed === "/reports" || trimmed.startsWith("/reports ")) {
    const args = trimmed.slice(8).trim().split(/\s+/).filter(Boolean);
    return handleReports(args);
  }

  if (trimmed.startsWith("/report ")) {
    const reportId = trimmed.slice(8).trim();
    if (!reportId) {
      return "Usage: /report <report-id>";
    }
    return handleReport(reportId);
  }

  return null;
}

// ============================================
// Factory Functions
// ============================================

export function createReportingContext(
  taskDescription: string,
  workingDirectory?: string,
  model?: string
): AgentReportingContext {
  return new AgentReportingContext(taskDescription, workingDirectory, model);
}

// ============================================
// Git Integration Helpers
// ============================================

/**
 * Extract commit hash from git commit output
 */
export function extractCommitHash(output: string): string | null {
  // Match patterns like: [main abc1234] or [feature/x 1234567] or just 7-char hex
  const match = output.match(/\[[\w\/-]+\s+([a-f0-9]{7,})\]/) ||
    output.match(/([a-f0-9]{40})/);

  return match?.[1]?.slice(0, 7) || null;
}

/**
 * Extract branch name from git status or branch output
 */
export function extractBranchName(output: string): string | null {
  // Match "On branch <name>" or "* <name>"
  const match = output.match(/On branch (\S+)/) ||
    output.match(/\* (\S+)/);

  return match?.[1] || null;
}

// ============================================
// Voice System Integration
// ============================================

/**
 * Format completion for voice output (TTS)
 * Generates a short, sarcastic completion summary for the voice hook
 */
export function formatForVoice(report: CompletionReport): string {
  const openers = [
    "Oh look, another miracle.",
    "Wow, I actually did something.",
    "Behold, my masterpiece.",
    "Against all odds, it worked.",
    "You're welcome, by the way.",
    "Task complete, as if there was any doubt.",
    "The code gods have smiled upon us.",
    "Another day, another task conquered.",
  ];

  const closers = [
    "I deserve a cookie.",
    "You can applaud now.",
    "No need to thank me.",
    "Try not to break it.",
    "I'll be here all week.",
    "The machine does its magic again.",
    "Pure digital brilliance.",
  ];

  const opener = openers[Math.floor(Math.random() * openers.length)];
  const closer = closers[Math.floor(Math.random() * closers.length)];

  // Build summary
  const parts: string[] = [opener];

  // Files info
  const totalFiles = report.filesCreated.length + report.filesModified.length;
  if (totalFiles > 0) {
    if (report.filesCreated.length > 0 && report.filesModified.length > 0) {
      parts.push(`Created ${report.filesCreated.length} and modified ${report.filesModified.length} files.`);
    } else if (report.filesCreated.length > 0) {
      parts.push(`Created ${report.filesCreated.length} file${report.filesCreated.length > 1 ? "s" : ""}.`);
    } else {
      parts.push(`Modified ${report.filesModified.length} file${report.filesModified.length > 1 ? "s" : ""}.`);
    }
  }

  // Git info
  if (report.gitBranch) {
    parts.push(`On branch ${report.gitBranch}.`);
  }

  if (report.gitCommit) {
    parts.push("Committed.");
  }

  // Duration
  parts.push(`Took ${report.duration}.`);

  // Status
  if (report.status !== "success") {
    parts.push(report.status === "partial" ? "Partially done." : "Well, some issues occurred.");
  }

  // Closer
  parts.push(closer);

  return parts.join(" ");
}

/**
 * Generate the completion marker for voice hook detection
 */
export function generateCompletionMarker(report: CompletionReport): string {
  const voiceText = formatForVoice(report);
  return `\n\n\uD83C\uDFAF COMPLETED: ${voiceText}`;
}
