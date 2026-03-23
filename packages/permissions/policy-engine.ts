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
// Condition syntax validation
// ============================================

/** Max allowed length for regex-like patterns in conditions to prevent ReDoS */
const MAX_PATTERN_LENGTH = 200;

/** Valid condition operators */
const VALID_OPERATORS = ["contains", "in", "equals", "starts_with", "ends_with"] as const;

type ConditionOperator = typeof VALID_OPERATORS[number];

interface ParsedClause {
  field: string;
  operator: ConditionOperator;
  value: string;       // for contains, equals, starts_with, ends_with
  values?: string[];   // for "in" operator
}

interface ParsedCondition {
  /** Clauses joined by OR - any match = true */
  orGroups: ParsedClause[][];
}

/**
 * Parse and validate a condition string at load time.
 * Throws if syntax is invalid, so bad policies fail fast.
 */
function parseCondition(condition: string): ParsedCondition {
  const cond = condition.trim();
  if (!cond) throw new Error("Empty condition");
  if (cond.length > 2000) throw new Error("Condition too long (max 2000 chars)");

  // Split on " or " for OR groups, then " and " within each group for AND
  const orParts = cond.split(/\s+or\s+/i);
  const orGroups: ParsedClause[][] = [];

  for (const orPart of orParts) {
    const andParts = orPart.split(/\s+and\s+/i);
    const andClauses: ParsedClause[] = [];

    for (const rawClause of andParts) {
      const clause = rawClause.trim();
      if (!clause) throw new Error(`Empty clause in condition: "${condition}"`);

      const parsed = parseClause(clause);
      if (!parsed) {
        throw new Error(
          `Invalid condition syntax: "${clause}". ` +
          `Expected: "field contains value", "field in [a, b]", "field equals value", ` +
          `"field starts_with value", or "field ends_with value"`
        );
      }
      andClauses.push(parsed);
    }

    orGroups.push(andClauses);
  }

  return { orGroups };
}

function parseClause(clause: string): ParsedClause | null {
  // "field contains value"
  const containsMatch = clause.match(/^(\w+)\s+contains\s+(.+)$/i);
  if (containsMatch) {
    const value = containsMatch[2].trim();
    if (value.length > MAX_PATTERN_LENGTH) {
      throw new Error(`Pattern too long (max ${MAX_PATTERN_LENGTH} chars): "${value.slice(0, 50)}..."`);
    }
    return { field: containsMatch[1], operator: "contains", value };
  }

  // "field in [a, b, c]"
  const inMatch = clause.match(/^(\w+)\s+in\s+\[([^\]]*)\]$/i);
  if (inMatch) {
    const values = inMatch[2].split(",").map((s) => s.trim()).filter(Boolean);
    return { field: inMatch[1], operator: "in", value: "", values };
  }

  // "field equals value"
  const equalsMatch = clause.match(/^(\w+)\s+equals\s+(.+)$/i);
  if (equalsMatch) {
    return { field: equalsMatch[1], operator: "equals", value: equalsMatch[2].trim() };
  }

  // "field starts_with value"
  const startsMatch = clause.match(/^(\w+)\s+starts_with\s+(.+)$/i);
  if (startsMatch) {
    return { field: startsMatch[1], operator: "starts_with", value: startsMatch[2].trim() };
  }

  // "field ends_with value"
  const endsMatch = clause.match(/^(\w+)\s+ends_with\s+(.+)$/i);
  if (endsMatch) {
    return { field: endsMatch[1], operator: "ends_with", value: endsMatch[2].trim() };
  }

  return null;
}

// ============================================
// In-memory policy store
// ============================================

let _policies: PolicyRule[] = [];
/** Pre-parsed conditions keyed by rule index for fast evaluation */
let _parsedConditions: Map<number, ParsedCondition> = new Map();
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
  const parsed: Map<number, ParsedCondition> = new Map();

  for (const src of sources) {
    try {
      const raw = fs.readFileSync(src, "utf-8");
      const file = parseYaml(raw) as PolicyFile;
      if (file?.policies && Array.isArray(file.policies)) {
        for (const rule of file.policies) {
          const idx = rules.length;
          // Validate condition syntax at load time - fail fast
          try {
            parsed.set(idx, parseCondition(rule.condition));
          } catch (err) {
            console.warn(
              `[policy-engine] Invalid condition in rule "${rule.name}" from ${src}: ${err}`
            );
            // Skip invalid rules rather than crash
            continue;
          }
          rules.push(rule);
        }
      }
    } catch (err) {
      console.warn(`[policy-engine] Failed to load ${src}: ${err}`);
    }
  }

  _policies = rules;
  _parsedConditions = parsed;
  _loaded = true;
  return rules;
}

/**
 * Add a rule at runtime (e.g. from agent configuration).
 */
export function addPolicy(rule: PolicyRule): void {
  if (!_loaded) loadPolicies();
  // Validate at add time - throws if invalid
  const parsed = parseCondition(rule.condition);
  const idx = _policies.length;
  _parsedConditions.set(idx, parsed);
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
 * Coerce a context value to a comparable string.
 * Handles null, undefined, numbers, booleans, arrays, and objects.
 */
function coerceToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(coerceToString).join(",");
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return String(value);
}

/**
 * Evaluates a pre-parsed condition against a context object.
 * Uses the parsed condition cache from load time.
 *
 * Supported syntax:
 *   "field contains VALUE"
 *   "field equals VALUE"
 *   "field starts_with VALUE"
 *   "field ends_with VALUE"
 *   "field in [a, b, c]"
 *   Clauses joined by "and" (all must match) or "or" (any must match)
 *
 * All comparisons are case-insensitive.
 */
function evaluateCondition(ruleIndex: number, condition: string, context: PolicyContext): boolean {
  // Use pre-parsed condition if available
  let parsed = _parsedConditions.get(ruleIndex);
  if (!parsed) {
    // Fallback: parse at runtime (e.g. for dynamically added rules)
    try {
      parsed = parseCondition(condition);
    } catch {
      return false; // Invalid conditions never match
    }
  }

  // OR groups: any group matching = true
  return parsed.orGroups.some((andClauses) =>
    // AND within group: all clauses must match
    andClauses.every((clause) => evaluateClauseParsed(clause, context))
  );
}

function evaluateClauseParsed(clause: ParsedClause, context: PolicyContext): boolean {
  const rawValue = context[clause.field];
  const haystack = coerceToString(rawValue).toLowerCase();

  switch (clause.operator) {
    case "contains":
      return haystack.includes(clause.value.toLowerCase());

    case "equals":
      return haystack === clause.value.toLowerCase();

    case "starts_with":
      return haystack.startsWith(clause.value.toLowerCase());

    case "ends_with":
      return haystack.endsWith(clause.value.toLowerCase());

    case "in": {
      const items = (clause.values ?? []).map((s) => s.toLowerCase());
      return items.includes(haystack);
    }

    default:
      return false;
  }
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

  // Build index-aware list for pre-parsed condition lookup
  const withIndex = applicable.map((r) => ({
    rule: r,
    index: _policies.indexOf(r),
  }));

  // 1. Explicit allow - early exit
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "allow")) {
    if (evaluateCondition(index, rule.condition, context)) {
      return { allowed: true };
    }
  }

  // 2. Hard block
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "block")) {
    if (evaluateCondition(index, rule.condition, context)) {
      return { allowed: false, reason: `[${rule.name}] ${rule.message}` };
    }
  }

  // 3. Soft deny (requires user approval)
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "require_approval")) {
    if (evaluateCondition(index, rule.condition, context)) {
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
