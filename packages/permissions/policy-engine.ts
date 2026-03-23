/**
 * 8gent Code - Policy Engine
 *
 * Lightweight YAML-driven policy evaluation for agent actions.
 * Governs file access, commands, git ops, network, and secrets.
 *
 * Inspired by NemoClaw (https://github.com/nemo-claw) — rebuilt from scratch in <200 lines.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parse as parseYaml } from "yaml";
import type { PolicyRule, PolicyDecision, PolicyContext, PolicyActionType, PolicyFile } from "./types.js";

// ============================================
// Constants
// ============================================

const DEFAULT_POLICY_PATH = path.join(
  path.dirname(
    typeof __filename !== "undefined"
      ? __filename
      : new URL(import.meta.url).pathname
  ),
  "default-policies.yaml"
);

const USER_POLICY_PATH = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "policies.yaml"
);

// ============================================
// In-memory policy store
// ============================================

let _policies: PolicyRule[] = [];
let _loaded = false;

// ============================================
// YAML Loader
// ============================================

/**
 * Load policies from a YAML file path.
 * Falls back to default-policies.yaml if path not provided or missing.
 */
export function loadPolicies(yamlPath?: string): PolicyRule[] {
  const sources: string[] = [];

  // 1. Ship defaults
  if (fs.existsSync(DEFAULT_POLICY_PATH)) {
    sources.push(DEFAULT_POLICY_PATH);
  }

  // 2. User overrides
  if (fs.existsSync(USER_POLICY_PATH)) {
    sources.push(USER_POLICY_PATH);
  }

  // 3. Caller-specified path
  if (yamlPath && fs.existsSync(yamlPath)) {
    sources.push(yamlPath);
  }

  const rules: PolicyRule[] = [];

  for (const src of sources) {
    try {
      const raw = fs.readFileSync(src, "utf-8");
      const parsed = parseYaml(raw) as PolicyFile;
      if (parsed?.policies && Array.isArray(parsed.policies)) {
        rules.push(...parsed.policies);
      }
    } catch (err) {
      console.warn(`[policy-engine] Failed to load ${src}: ${err}`);
    }
  }

  _policies = rules;
  _loaded = true;
  return rules;
}

/**
 * Add a rule at runtime (e.g. from agent configuration).
 */
export function addPolicy(rule: PolicyRule): void {
  if (!_loaded) loadPolicies();
  _policies.push(rule);
}

/**
 * Get the current in-memory policy list (loads defaults if not yet loaded).
 */
export function getPolicies(): PolicyRule[] {
  if (!_loaded) loadPolicies();
  return [..._policies];
}

// ============================================
// Condition Evaluator
// ============================================

/**
 * Evaluates a plain-English condition string against a context object.
 *
 * Supported syntax:
 *   "field contains VALUE"
 *   "field contains A or field contains B"
 *   "field in [a, b, c]"
 *
 * All comparisons are case-insensitive substring or set membership.
 */
function evaluateCondition(condition: string, context: PolicyContext): boolean {
  // Normalise
  const cond = condition.trim().toLowerCase();

  // Split on " or " (all must be checked — any match = true)
  const clauses = cond.split(/\s+or\s+/);

  return clauses.some((clause) => evaluateClause(clause.trim(), context));
}

function evaluateClause(clause: string, context: PolicyContext): boolean {
  // "field contains value"
  const containsMatch = clause.match(/^(\w+)\s+contains\s+(.+)$/);
  if (containsMatch) {
    const [, field, needle] = containsMatch;
    const haystack = String(context[field] ?? "").toLowerCase();
    return haystack.includes(needle.trim().toLowerCase());
  }

  // "field in [a, b, c]"
  const inMatch = clause.match(/^(\w+)\s+in\s+\[([^\]]+)\]$/);
  if (inMatch) {
    const [, field, listRaw] = inMatch;
    const items = listRaw.split(",").map((s) => s.trim().toLowerCase());
    const value = String(context[field] ?? "").toLowerCase();
    return items.includes(value);
  }

  return false;
}

// ============================================
// Core Evaluator
// ============================================

/**
 * Evaluate all loaded policies for a given action + context.
 *
 * Evaluation order:
 *   1. Disabled rules skipped
 *   2. "allow" rules checked first — if matched, immediately allowed
 *   3. "block" rules checked — if matched, hard deny
 *   4. "require_approval" rules checked — if matched, soft deny
 *   5. Default: allowed
 */
export function evaluatePolicy(
  action: PolicyActionType | string,
  context: PolicyContext
): PolicyDecision {
  if (!_loaded) loadPolicies();

  const applicable = _policies.filter(
    (r) =>
      (r.enabled !== false) &&
      (r.action === action || r.action === "*")
  );

  // 1. Explicit allow — early exit
  for (const rule of applicable.filter((r) => r.decision === "allow")) {
    if (evaluateCondition(rule.condition, context)) {
      return { allowed: true };
    }
  }

  // 2. Hard block
  for (const rule of applicable.filter((r) => r.decision === "block")) {
    if (evaluateCondition(rule.condition, context)) {
      return { allowed: false, reason: `[${rule.name}] ${rule.message}` };
    }
  }

  // 3. Soft deny (requires user approval)
  for (const rule of applicable.filter((r) => r.decision === "require_approval")) {
    if (evaluateCondition(rule.condition, context)) {
      return {
        allowed: false,
        reason: `[${rule.name}] ${rule.message}`,
        requiresApproval: true,
      };
    }
  }

  // Default: allow
  return { allowed: true };
}

// ============================================
// Convenience helpers
// ============================================

/** Quick check: is this file write allowed? */
export function checkFileWrite(filePath: string, content?: string): PolicyDecision {
  return evaluatePolicy("write_file", { path: filePath, content: content ?? "" });
}

/** Quick check: is this command allowed? */
export function checkCommand(command: string): PolicyDecision {
  return evaluatePolicy("run_command", { command });
}

/** Quick check: is pushing to this branch allowed? */
export function checkGitPush(branch: string): PolicyDecision {
  return evaluatePolicy("git_push", { branch });
}
