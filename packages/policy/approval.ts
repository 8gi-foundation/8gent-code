/**
 * @8gent/policy — Approval Gate
 *
 * Handles interactive approval prompts for actions that require
 * human confirmation before execution (e.g., force pushes, deletions).
 * Tracks approval history for audit trails.
 */

import * as readline from "readline";
import * as crypto from "crypto";
import type { PolicyAction, ApprovalRecord } from "./schema.js";

// ============================================
// Formatting
// ============================================

const ACTION_LABELS: Record<string, string> = {
  file_read: "Read file",
  file_write: "Write file",
  file_delete: "Delete file",
  command: "Execute command",
  network: "Network request",
  git_push: "Git push",
  git_force_push: "Git force push",
};

const ACTION_ICONS: Record<string, string> = {
  file_read: "[READ]",
  file_write: "[WRITE]",
  file_delete: "[DELETE]",
  command: "[CMD]",
  network: "[NET]",
  git_push: "[GIT]",
  git_force_push: "[GIT!]",
};

/**
 * Format an approval request into a human-readable string for CLI display.
 */
export function formatApprovalRequest(action: PolicyAction): string {
  const icon = ACTION_ICONS[action.type] ?? "[?]";
  const label = ACTION_LABELS[action.type] ?? action.type;
  const lines: string[] = [
    "",
    `  ${icon} Approval Required`,
    `  ${"=".repeat(40)}`,
    `  Action:  ${label}`,
    `  Target:  ${action.target}`,
  ];

  if (action.context) {
    lines.push(`  Context: ${action.context}`);
  }

  lines.push(`  ${"=".repeat(40)}`, "");
  return lines.join("\n");
}

// ============================================
// Approval Gate
// ============================================

export class ApprovalGate {
  private history: ApprovalRecord[] = [];
  private maxHistory: number;

  constructor(options?: { maxHistory?: number }) {
    this.maxHistory = options?.maxHistory ?? 1000;
  }

  /**
   * Prompt the user for approval of an action in CLI mode.
   * Returns true if approved, false if denied.
   */
  async requestApproval(action: PolicyAction, reason: string): Promise<boolean> {
    const formatted = formatApprovalRequest(action);

    // Print the formatted request
    process.stderr.write(formatted);
    process.stderr.write(`  Reason: ${reason}\n\n`);

    const approved = await this.promptUser("  Allow this action? [y/N] ");

    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      action,
      reason,
      approved,
      timestamp: new Date(),
      respondedBy: "user",
    };

    this.addRecord(record);
    return approved;
  }

  /**
   * Record an auto-approved or auto-denied decision (no user prompt).
   */
  recordAutoDecision(action: PolicyAction, reason: string, approved: boolean): void {
    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      action,
      reason,
      approved,
      timestamp: new Date(),
      respondedBy: "auto",
    };
    this.addRecord(record);
  }

  /**
   * Get the full approval history for audit purposes.
   */
  getHistory(): readonly ApprovalRecord[] {
    return this.history;
  }

  /**
   * Get approval stats.
   */
  getStats(): { total: number; approved: number; denied: number; userDecisions: number; autoDecisions: number } {
    const approved = this.history.filter((r) => r.approved).length;
    const denied = this.history.length - approved;
    const userDecisions = this.history.filter((r) => r.respondedBy === "user").length;
    return {
      total: this.history.length,
      approved,
      denied,
      userDecisions,
      autoDecisions: this.history.length - userDecisions,
    };
  }

  /**
   * Clear approval history.
   */
  clearHistory(): void {
    this.history = [];
  }

  // ---- Private ----

  private addRecord(record: ApprovalRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  private promptUser(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      // If stdin is not a TTY (piped input, CI, etc.), default to deny
      if (!process.stdin.isTTY) {
        process.stderr.write("  (non-interactive mode — defaulting to deny)\n");
        resolve(false);
        return;
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      rl.question(prompt, (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === "y" || normalized === "yes");
      });
    });
  }
}
