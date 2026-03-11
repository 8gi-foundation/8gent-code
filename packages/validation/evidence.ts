/**
 * 8gent Code - Evidence Collection
 *
 * Automatically collects proof that actions succeeded.
 * The key principle: NOTHING is considered done without evidence.
 *
 * Evidence Types:
 * - file_exists: Verifies a file was created
 * - file_content: Shows first N chars of file content
 * - command_output: Captures command execution output
 * - screenshot: Visual evidence (for browser automation)
 * - diff: Git diff showing changes
 * - test_result: Test execution results
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { Step, ToolCallRecord } from "../workflow/plan-validate";

// ============================================
// Types
// ============================================

export type EvidenceType =
  | "file_exists"
  | "file_content"
  | "command_output"
  | "screenshot"
  | "diff"
  | "test_result"
  | "git_commit"
  | "git_status"
  | "directory_listing"
  | "json_content"
  | "error_log";

export interface Evidence {
  type: EvidenceType;
  description: string;
  data: string | object | boolean;
  timestamp: Date;
  verified: boolean;
  path?: string;           // File path if applicable
  command?: string;        // Command if applicable
  exitCode?: number;       // Exit code if command
  duration?: number;       // Duration in ms
  size?: number;           // File size in bytes
  hash?: string;           // Content hash for integrity
}

export interface EvidenceCollectorConfig {
  workingDirectory: string;
  maxContentLength?: number;    // Max chars to capture from file content
  captureScreenshots?: boolean;
  hashAlgorithm?: "md5" | "sha256";
}

export interface StepExecutionResult {
  output: string;
  toolCalls: ToolCallRecord[];
  exitCode?: number;
  duration?: number;
}

// ============================================
// Evidence Collector
// ============================================

export class EvidenceCollector {
  private config: EvidenceCollectorConfig;

  constructor(config: EvidenceCollectorConfig) {
    this.config = {
      maxContentLength: config.maxContentLength ?? 500,
      captureScreenshots: config.captureScreenshots ?? false,
      hashAlgorithm: config.hashAlgorithm ?? "sha256",
      ...config,
    };
  }

  /**
   * Collect evidence for a completed step
   */
  async collectForStep(step: Step, result: StepExecutionResult): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    // Analyze the step action to determine what evidence to collect
    const action = step.action.toLowerCase();

    // File creation/write evidence
    if (
      action.includes("create") ||
      action.includes("write") ||
      action.includes("generate") ||
      action.includes("file")
    ) {
      const paths = this.extractPaths(step.action);
      for (const filePath of paths) {
        const fileEvidence = await this.collectForFileWrite(filePath);
        evidence.push(...fileEvidence);
      }
    }

    // Command execution evidence
    if (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        if (call.tool === "run_command" && call.arguments.command) {
          const cmdEvidence = await this.collectForCommand(
            String(call.arguments.command),
            call.result
          );
          evidence.push(...cmdEvidence);
        }
      }
    }

    // Git commit evidence
    if (action.includes("commit") || action.includes("git")) {
      const gitEvidence = await this.collectForGitCommit();
      evidence.push(...gitEvidence);
    }

    // Directory structure evidence
    if (
      action.includes("scaffold") ||
      action.includes("init") ||
      action.includes("create project")
    ) {
      const dirEvidence = await this.collectDirectoryEvidence();
      evidence.push(...dirEvidence);
    }

    // If no specific evidence, capture the output as general evidence
    if (evidence.length === 0 && result.output) {
      evidence.push({
        type: "command_output",
        description: "Step execution output",
        data: result.output.slice(0, this.config.maxContentLength),
        timestamp: new Date(),
        verified: !result.output.toLowerCase().includes("error"),
      });
    }

    return evidence;
  }

  /**
   * Collect evidence for file write operations
   */
  async collectForFileWrite(filePath: string): Promise<Evidence[]> {
    const evidence: Evidence[] = [];
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.config.workingDirectory, filePath);

    // Check if file exists
    const exists = fs.existsSync(absolutePath);
    evidence.push({
      type: "file_exists",
      description: `File exists: ${filePath}`,
      data: exists,
      path: absolutePath,
      timestamp: new Date(),
      verified: exists,
    });

    if (exists) {
      try {
        const stats = fs.statSync(absolutePath);
        const content = fs.readFileSync(absolutePath, "utf-8");
        const hash = await this.hashContent(content);

        // File content evidence
        evidence.push({
          type: "file_content",
          description: `Content of ${filePath} (first ${this.config.maxContentLength} chars)`,
          data: content.slice(0, this.config.maxContentLength),
          path: absolutePath,
          timestamp: new Date(),
          verified: true,
          size: stats.size,
          hash,
        });

        // If it's a JSON file, parse and validate
        if (filePath.endsWith(".json")) {
          try {
            const parsed = JSON.parse(content);
            evidence.push({
              type: "json_content",
              description: `Valid JSON: ${filePath}`,
              data: parsed,
              path: absolutePath,
              timestamp: new Date(),
              verified: true,
            });
          } catch {
            evidence.push({
              type: "error_log",
              description: `Invalid JSON in ${filePath}`,
              data: "JSON parse error",
              path: absolutePath,
              timestamp: new Date(),
              verified: false,
            });
          }
        }
      } catch (err) {
        evidence.push({
          type: "error_log",
          description: `Error reading ${filePath}`,
          data: err instanceof Error ? err.message : String(err),
          path: absolutePath,
          timestamp: new Date(),
          verified: false,
        });
      }
    }

    return evidence;
  }

  /**
   * Collect evidence for command execution
   */
  async collectForCommand(command: string, output: string): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    // Check for error patterns in output
    const hasError =
      output.toLowerCase().includes("error") ||
      output.toLowerCase().includes("failed") ||
      output.toLowerCase().includes("exception") ||
      output.toLowerCase().includes("fatal");

    evidence.push({
      type: "command_output",
      description: `Command: ${command.slice(0, 50)}...`,
      data: output.slice(0, this.config.maxContentLength),
      command,
      timestamp: new Date(),
      verified: !hasError,
    });

    return evidence;
  }

  /**
   * Collect evidence for git commit
   */
  async collectForGitCommit(): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    try {
      // Get latest commit info
      const commitLog = await this.runCommand("git log -1 --oneline");
      if (commitLog.output) {
        evidence.push({
          type: "git_commit",
          description: "Latest commit",
          data: commitLog.output.trim(),
          timestamp: new Date(),
          verified: commitLog.exitCode === 0,
          exitCode: commitLog.exitCode,
        });
      }

      // Get diff stats
      const diffStats = await this.runCommand("git diff HEAD~1 --stat");
      if (diffStats.output) {
        evidence.push({
          type: "diff",
          description: "Commit diff stats",
          data: diffStats.output.trim(),
          timestamp: new Date(),
          verified: true,
        });
      }

      // Get current status
      const status = await this.runCommand("git status --porcelain");
      evidence.push({
        type: "git_status",
        description: "Git working tree status",
        data: status.output.trim() || "(clean)",
        timestamp: new Date(),
        verified: true,
      });
    } catch (err) {
      evidence.push({
        type: "error_log",
        description: "Git evidence collection failed",
        data: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
        verified: false,
      });
    }

    return evidence;
  }

  /**
   * Collect directory listing evidence
   */
  async collectDirectoryEvidence(dirPath?: string): Promise<Evidence[]> {
    const evidence: Evidence[] = [];
    const targetDir = dirPath || this.config.workingDirectory;

    try {
      const result = await this.runCommand(`ls -la "${targetDir}"`);
      evidence.push({
        type: "directory_listing",
        description: `Directory listing: ${targetDir}`,
        data: result.output.trim(),
        path: targetDir,
        timestamp: new Date(),
        verified: result.exitCode === 0,
      });

      // Count files and directories
      const files = fs.readdirSync(targetDir);
      const fileCount = files.filter((f) =>
        fs.statSync(path.join(targetDir, f)).isFile()
      ).length;
      const dirCount = files.filter((f) =>
        fs.statSync(path.join(targetDir, f)).isDirectory()
      ).length;

      evidence.push({
        type: "directory_listing",
        description: `Directory contents summary`,
        data: { files: fileCount, directories: dirCount, total: files.length },
        path: targetDir,
        timestamp: new Date(),
        verified: true,
      });
    } catch (err) {
      evidence.push({
        type: "error_log",
        description: `Directory listing failed: ${targetDir}`,
        data: err instanceof Error ? err.message : String(err),
        timestamp: new Date(),
        verified: false,
      });
    }

    return evidence;
  }

  /**
   * Collect test result evidence
   */
  async collectForTestRun(command: string): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    try {
      const result = await this.runCommand(command, 120000); // 2 min timeout

      // Parse test output for pass/fail counts
      const output = result.output;
      const passMatch = output.match(/(\d+)\s*(?:passed|passing)/i);
      const failMatch = output.match(/(\d+)\s*(?:failed|failing)/i);
      const skipMatch = output.match(/(\d+)\s*(?:skipped|pending)/i);

      const testResults = {
        passed: passMatch ? parseInt(passMatch[1]) : 0,
        failed: failMatch ? parseInt(failMatch[1]) : 0,
        skipped: skipMatch ? parseInt(skipMatch[1]) : 0,
        exitCode: result.exitCode,
        duration: result.duration,
        output: output.slice(-this.config.maxContentLength!), // Last N chars
      };

      evidence.push({
        type: "test_result",
        description: `Test run: ${command}`,
        data: testResults,
        command,
        timestamp: new Date(),
        verified: testResults.failed === 0 && result.exitCode === 0,
        exitCode: result.exitCode,
        duration: result.duration,
      });
    } catch (err) {
      evidence.push({
        type: "error_log",
        description: `Test run failed: ${command}`,
        data: err instanceof Error ? err.message : String(err),
        command,
        timestamp: new Date(),
        verified: false,
      });
    }

    return evidence;
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Extract file paths from text
   */
  private extractPaths(text: string): string[] {
    const paths: string[] = [];

    // Match quoted paths
    const quotedPaths = text.match(/"([^"]+\.[a-z]+)"/gi) || [];
    paths.push(...quotedPaths.map((p) => p.replace(/"/g, "")));

    // Match paths with extensions
    const extensionPaths =
      text.match(/[\w./\-]+\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs)/gi) || [];
    paths.push(...extensionPaths);

    // Match paths starting with common directories
    const dirPaths = text.match(/(?:src|lib|app|pages|components)\/[\w./\-]+/gi) || [];
    paths.push(...dirPaths);

    // Deduplicate
    return [...new Set(paths)];
  }

  /**
   * Run a command and capture output
   */
  private runCommand(
    command: string,
    timeoutMs: number = 30000
  ): Promise<{ output: string; exitCode: number; duration: number }> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = "";
      let stderr = "";

      const proc = spawn("sh", ["-c", command], {
        cwd: this.config.workingDirectory,
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out: ${command}`));
      }, timeoutMs);

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({
          output: stdout + stderr,
          exitCode: code ?? 0,
          duration: Date.now() - startTime,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Hash file content for integrity verification
   */
  private async hashContent(content: string): Promise<string> {
    const crypto = await import("crypto");
    return crypto
      .createHash(this.config.hashAlgorithm || "sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16); // Short hash for display
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format evidence for display
 */
export function formatEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) {
    return "No evidence collected.";
  }

  const lines: string[] = ["Evidence Collected:"];

  for (const ev of evidence) {
    const icon = ev.verified ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const typeLabel = `[${ev.type}]`.padEnd(18);

    lines.push(`  ${icon} ${typeLabel} ${ev.description}`);

    // Show data preview for certain types
    if (ev.type === "file_content" && typeof ev.data === "string") {
      const preview = ev.data.split("\n")[0].slice(0, 60);
      lines.push(`      └─ "${preview}..."`);
    }

    if (ev.type === "git_commit" && typeof ev.data === "string") {
      lines.push(`      └─ ${ev.data}`);
    }

    if (ev.type === "test_result" && typeof ev.data === "object") {
      const results = ev.data as Record<string, unknown>;
      lines.push(
        `      └─ passed: ${results.passed}, failed: ${results.failed}, skipped: ${results.skipped}`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Summarize evidence collection
 */
export function summarizeEvidence(evidence: Evidence[]): {
  total: number;
  verified: number;
  failed: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};

  for (const ev of evidence) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
  }

  return {
    total: evidence.length,
    verified: evidence.filter((e) => e.verified).length,
    failed: evidence.filter((e) => !e.verified).length,
    byType,
  };
}

/**
 * Filter evidence by type
 */
export function filterEvidence(evidence: Evidence[], types: EvidenceType[]): Evidence[] {
  return evidence.filter((e) => types.includes(e.type));
}

/**
 * Check if all required evidence is verified
 */
export function isEvidenceSufficient(
  evidence: Evidence[],
  requiredTypes: EvidenceType[]
): boolean {
  for (const type of requiredTypes) {
    const typeEvidence = evidence.filter((e) => e.type === type);
    if (typeEvidence.length === 0 || !typeEvidence.some((e) => e.verified)) {
      return false;
    }
  }
  return true;
}
