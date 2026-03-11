/**
 * 8gent Code - Completion Report Types
 *
 * Type definitions for the completion reporting system.
 */

// ============================================
// Core Report Types
// ============================================

export interface StepSummary {
  index: number;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  duration?: number; // milliseconds
  toolsUsed?: string[];
  filesAffected?: string[];
  error?: string;
}

export interface EvidenceSummary {
  type: "files_exist" | "build_passes" | "tests_pass" | "git_committed" | "server_running" | "custom";
  label: string;
  status: "pass" | "fail" | "pending" | "skipped";
  details?: string;
  url?: string;
}

export interface CompletionReport {
  // Unique identifier
  id: string;
  taskId?: string;

  // Summary
  summary: string;
  detailedSummary?: string;

  // File changes
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];

  // Metrics
  toolsUsed: number;
  tokensUsed?: number;
  tokensSaved?: number;
  duration: string; // formatted like "2m 34s"
  durationMs: number;

  // Steps taken
  steps: StepSummary[];

  // Evidence of completion
  evidence: EvidenceSummary[];

  // Git info
  gitCommit?: string;
  gitBranch?: string;

  // Confidence score (0-100)
  confidence: number;

  // Timestamps
  startedAt: Date;
  completedAt: Date;

  // Working directory
  workingDirectory: string;

  // Error if failed
  error?: string;
  errorStack?: string;

  // Status
  status: "success" | "partial" | "failed";
}

// ============================================
// Task Context Types (input to reporter)
// ============================================

export interface FileOperation {
  type: "create" | "modify" | "delete" | "read";
  path: string;
  timestamp: number;
}

export interface ToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  duration: number;
  timestamp: number;
  success: boolean;
}

export interface TaskStep {
  index: number;
  description: string;
  startTime: number;
  endTime?: number;
  tools: ToolInvocation[];
  files: FileOperation[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface TaskContext {
  // Task info
  taskId: string;
  taskDescription: string;

  // Timing
  startTime: number;
  endTime?: number;

  // Working directory
  workingDirectory: string;

  // Steps
  steps: TaskStep[];

  // All tool invocations
  tools: ToolInvocation[];

  // All file operations
  fileOperations: FileOperation[];

  // Git info
  gitBranch?: string;
  gitCommits?: string[];

  // Token usage
  tokensUsed?: number;
  tokensSaved?: number;

  // Final result
  result?: string;
  error?: string;

  // Model used
  model?: string;
}

// ============================================
// Report Storage Types
// ============================================

export interface StoredReport extends CompletionReport {
  version: number;
  storedAt: Date;
}

export interface ReportQuery {
  limit?: number;
  offset?: number;
  status?: CompletionReport["status"];
  after?: Date;
  before?: Date;
  workingDirectory?: string;
}

export interface ReportListItem {
  id: string;
  summary: string;
  status: CompletionReport["status"];
  duration: string;
  completedAt: Date;
  filesChanged: number;
}
