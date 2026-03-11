/**
 * 8gent Code - Reporting Package
 *
 * Completion report generation and history management.
 *
 * Usage:
 * ```typescript
 * import {
 *   CompletionReporter,
 *   TaskContextTracker,
 *   ReportHistory,
 *   getCompletionReporter,
 *   getReportHistory,
 * } from "../reporting";
 *
 * // Track a task
 * const tracker = new TaskContextTracker("task_123", "Build a landing page", process.cwd());
 * tracker.startStep("Create HTML file");
 * tracker.recordFileOperation({ type: "create", path: "index.html", timestamp: Date.now() });
 * tracker.completeStep();
 *
 * // Generate report
 * const reporter = getCompletionReporter();
 * const context = tracker.complete();
 * const report = reporter.generateReport(context);
 *
 * // Display
 * console.log(reporter.formatForTerminal(report));
 *
 * // Save
 * reporter.saveReport(report);
 *
 * // List reports
 * const history = getReportHistory();
 * const reports = history.listReports({ limit: 10 });
 * ```
 */

// Types
export * from "./types";

// Formatter utilities
export * from "./formatter";

// Completion reporter
export {
  CompletionReporter,
  TaskContextTracker,
  createReporter,
  createTracker,
  getCompletionReporter,
} from "./completion";

// Report history
export {
  ReportHistory,
  getReportHistory,
  createHistory,
  handleReportsCommand,
  handleReportCommand,
  type ReportStats,
} from "./history";

// Agent integration
export {
  AgentReportingContext,
  createReportingContext,
  handleReports,
  handleReport,
  isReportCommand,
  handleReportCommands,
  extractCommitHash,
  extractBranchName,
  formatForVoice,
  generateCompletionMarker,
} from "./integration";
