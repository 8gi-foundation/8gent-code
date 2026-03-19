/**
 * @8gent/policy — Policy YAML Schema Types
 *
 * Defines the shape of .8gent/policy.yaml configuration files.
 * Inspired by NemoClaw's declarative security policy model.
 */

// ============================================
// Core Types
// ============================================

export type ActionType =
  | "file_read"
  | "file_write"
  | "file_delete"
  | "command"
  | "network"
  | "git_push"
  | "git_force_push";

export interface PolicyAction {
  type: ActionType;
  target: string;
  context?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  alternatives?: string[];
}

// ============================================
// Policy YAML Structure
// ============================================

export interface FilesystemRules {
  allow: string[];
  deny: string[];
  requireApproval: string[];
}

export interface CommandRules {
  allow: string[];
  deny: string[];
  requireApproval: string[];
}

export interface NetworkRules {
  allow: string[];
  deny: string[];
}

export interface InferenceRules {
  /** File patterns that must only be processed by local models */
  localOnly: string[];
  /** File patterns safe to send to cloud models */
  cloudAllowed: string[];
}

export interface PolicyRules {
  filesystem: FilesystemRules;
  commands: CommandRules;
  network: NetworkRules;
  inference: InferenceRules;
}

export interface Policy {
  version: number;
  rules: PolicyRules;
}

// ============================================
// Approval Types
// ============================================

export interface ApprovalRecord {
  id: string;
  action: PolicyAction;
  reason: string;
  approved: boolean;
  timestamp: Date;
  respondedBy: "user" | "auto";
}

// ============================================
// Model Router Types
// ============================================

export type ModelProvider = "local" | "cloud";

export interface ModelChoice {
  provider: ModelProvider;
  model: string;
  reason: string;
}
