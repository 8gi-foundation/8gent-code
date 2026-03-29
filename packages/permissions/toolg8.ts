/**
 * ToolG8 - Gate middleware for all tool calls.
 *
 * Wraps every tool execution through NemoClaw policy evaluation.
 * Logs every gate decision to audit trail for traceability.
 *
 * Part of the G8WAY governance layer (#988).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { evaluatePolicy } from "./policy-engine.js";
import type { PolicyActionType, PolicyContext, PolicyDecision } from "./types.js";

// ============================================
// Types
// ============================================

export interface GateResult {
  allowed: boolean;
  reason?: string;
  alternative?: string;
}

interface AuditEntry {
  timestamp: string;
  agentId: string;
  action: PolicyActionType;
  context: Record<string, unknown>;
  allowed: boolean;
  reason?: string;
}

// ============================================
// Audit log path
// ============================================

const AUDIT_DIR = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "audit"
);
const AUDIT_PATH = path.join(AUDIT_DIR, "toolg8.jsonl");

// ============================================
// ToolG8 Class
// ============================================

export class ToolG8 {
  private static _instance: ToolG8 | null = null;

  static instance(): ToolG8 {
    if (!ToolG8._instance) {
      ToolG8._instance = new ToolG8();
    }
    return ToolG8._instance;
  }

  /**
   * Gate a tool call through policy evaluation.
   *
   * @param agentId - ID of the agent making the call
   * @param action - The policy action type (read_file, write_file, run_command, etc.)
   * @param context - Context fields for condition evaluation
   * @returns GateResult with allowed/denied and reason
   */
  gate(agentId: string, action: PolicyActionType, context: PolicyContext): GateResult {
    // Inject agentId into context for per-agent scoping
    const fullContext: PolicyContext = { ...context, agentId };

    const decision: PolicyDecision = evaluatePolicy(action, fullContext);

    const result: GateResult = {
      allowed: decision.allowed,
    };

    if (!decision.allowed && "reason" in decision) {
      result.reason = decision.reason;
      result.alternative = this.suggestAlternative(action);
    }

    // Audit log (fire-and-forget, never blocks)
    this.audit(agentId, action, context, result);

    return result;
  }

  /**
   * Suggest a safe alternative when an action is blocked.
   */
  private suggestAlternative(action: PolicyActionType): string | undefined {
    switch (action) {
      case "write_file":
        return "Use edit_file with targeted replacements instead of full file writes.";
      case "run_command":
        return "Try a read-only command (git status, ls, cat) or request approval.";
      case "git_push":
        return "Push to a feature branch instead of a protected branch.";
      case "network_request":
        return "Use web_search or web_fetch with known-safe domains.";
      case "secret_write":
        return "Use environment variables via .env files, not direct secret writes.";
      case "delete_file":
        return "Archive the file instead of deleting, or request approval.";
      default:
        return undefined;
    }
  }

  /**
   * Append audit entry to JSONL log.
   * Silent on failure - audit must never block tool execution.
   */
  private audit(
    agentId: string,
    action: PolicyActionType,
    context: PolicyContext,
    result: GateResult
  ): void {
    try {
      if (!fs.existsSync(AUDIT_DIR)) {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
      }

      // Strip content field to keep audit log lean
      const safeContext: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(context)) {
        if (k === "content") continue;
        safeContext[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "..." : v;
      }

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        agentId,
        action,
        context: safeContext,
        allowed: result.allowed,
        reason: result.reason,
      };

      fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n");
    } catch {
      // Silent - audit failure must never block execution
    }
  }
}
