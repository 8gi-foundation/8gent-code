/**
 * WorktreePool types — isolated parallel agent execution.
 */

export type WorktreeTaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export interface WorktreeTask {
  id: string;
  prompt: string;
  branch: string;
  worktreePath: string;
  model?: string;
  status: WorktreeTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  pid?: number;
}

export interface WorktreeResult {
  taskId: string;
  status: WorktreeTaskStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  filesChanged: string[];
  completedAt: number;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string | "broadcast";
  type: "task" | "result" | "status" | "question" | "notification";
  content: string;
  timestamp: number;
}

export interface WorktreePoolOptions {
  /** Max concurrent worktrees. Default: 4 */
  maxConcurrent?: number;
  /** Per-task timeout in ms. Default: 600_000 (10 min) */
  taskTimeoutMs?: number;
  /** Root path of the git repo */
  projectRoot?: string;
}
