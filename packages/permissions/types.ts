/**
 * 8gent Code - Permission + Policy Types
 *
 * Extends the base permission system with structured policy rules.
 * Policy engine inspired by NemoClaw (https://github.com/nemo-claw) — rebuilt from scratch.
 */

// ============================================
// Existing permission types (re-exported)
// ============================================

export type { PermissionConfig, PermissionRequest, PermissionLog } from "./index.js";

// ============================================
// Policy types
// ============================================

/** The action category being evaluated */
export type PolicyActionType =
  | "write_file"
  | "read_file"
  | "delete_file"
  | "run_command"
  | "git_push"
  | "git_commit"
  | "network_request"
  | "env_access"
  | "secret_write";

/** What the policy engine decides */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; requiresApproval?: boolean };

/** A single policy rule loaded from YAML */
export interface PolicyRule {
  name: string;
  action: PolicyActionType | "*";
  /** Plain-English condition — evaluated by the engine via keyword matching */
  condition: string;
  /** block = hard deny | require_approval = soft deny with user gate | allow = explicit allow */
  decision: "block" | "require_approval" | "allow";
  message: string;
  /** Optional: only active in these environments */
  environments?: string[];
  /** Whether this rule is active (default: true) */
  enabled?: boolean;
  /** Whether this rule is immutable (cannot be overridden by addPolicy). Set automatically for default rules. */
  immutable?: boolean;
}

/** Top-level YAML policy file structure */
export interface PolicyFile {
  version?: number;
  policies: PolicyRule[];
}

/** Context passed to evaluatePolicy — keys vary by action */
export interface PolicyContext {
  /** For write_file / read_file / delete_file */
  path?: string;
  /** For write_file — content being written */
  content?: string;
  /** For run_command */
  command?: string;
  /** For git_push / git_commit */
  branch?: string;
  /** For network_request */
  url?: string;
  /** For env_access / secret_write */
  key?: string;
  /** Freeform extra fields */
  [key: string]: unknown;
}
