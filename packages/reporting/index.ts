/**
 * 8gent Code - Reporting Package
 */

// Types (kept for any remaining consumers)
export * from "./types";

// Formatter utilities
export * from "./formatter";

// Legacy completion reporter (still used by integration.ts)
export {
  CompletionReporter,
  TaskContextTracker,
  createReporter,
  createTracker,
  getCompletionReporter,
} from "./completion";

// Report history (legacy — will be removed)
export {
  ReportHistory,
  getReportHistory,
  createHistory,
  handleReportsCommand,
  handleReportCommand,
  type ReportStats,
} from "./history";

// Agent integration (git helpers still used)
export {
  extractCommitHash,
  extractBranchName,
} from "./integration";

// Run log — the new hotness
export { appendRun, readRuns, getLogPath, type RunLogEntry } from "./runlog";
