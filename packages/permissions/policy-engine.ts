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
import * as crypto from "crypto";
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

const POLICY_CHECKSUM_PATH = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "policy-checksum"
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
/** Flag set when policy file checksum does not match stored hash */
let _integrityWarning: string | null = null;

// ============================================
// YAML Loader
// ============================================

/**
 * Compute SHA-256 hash of a string.
 */
function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Verify or store a policy file checksum.
 * On first load, stores the hash. On subsequent loads, compares.
 * Returns null if valid/first-run, or an error string if mismatch.
 */
function verifyChecksum(yamlContent: string): string | null {
  const hash = sha256(yamlContent);

  try {
    if (fs.existsSync(POLICY_CHECKSUM_PATH)) {
      const storedHash = fs.readFileSync(POLICY_CHECKSUM_PATH, "utf-8").trim();
      if (storedHash !== hash) {
        return `Policy checksum mismatch: expected ${storedHash.slice(0, 12)}..., got ${hash.slice(0, 12)}...`;
      }
      return null;
    }

    // First run - store the checksum
    const dir = path.dirname(POLICY_CHECKSUM_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(POLICY_CHECKSUM_PATH, hash + "\n");
    return null;
  } catch (err) {
    return `Policy checksum verification failed: ${err}`;
  }
}

/**
 * Load policies from a YAML file path.
 * Falls back to default-policies.yaml if path not provided or missing.
 *
 * Default policy rules are marked immutable - they cannot be overridden by addPolicy().
 */
export function loadPolicies(yamlPath?: string): PolicyRule[] {
  const sources: { path: string; isDefault: boolean }[] = [];

  // 1. Ship defaults
  if (fs.existsSync(DEFAULT_POLICY_PATH)) {
    sources.push({ path: DEFAULT_POLICY_PATH, isDefault: true });
  }

  // 2. User overrides
  if (fs.existsSync(USER_POLICY_PATH)) {
    sources.push({ path: USER_POLICY_PATH, isDefault: false });
  }

  // 3. Caller-specified path
  if (yamlPath && fs.existsSync(yamlPath)) {
    sources.push({ path: yamlPath, isDefault: false });
  }

  const rules: PolicyRule[] = [];
  const parsed: Map<number, ParsedCondition> = new Map();
  _integrityWarning = null;

  // Collect all YAML content for checksum verification
  const allYamlContent: string[] = [];

  for (const src of sources) {
    try {
      const raw = fs.readFileSync(src.path, "utf-8");
      allYamlContent.push(raw);
      const file = parseYaml(raw) as PolicyFile;
      if (file?.policies && Array.isArray(file.policies)) {
        for (const rule of file.policies) {
          const idx = rules.length;
          // Validate condition syntax at load time - fail fast
          try {
            parsed.set(idx, parseCondition(rule.condition));
          } catch (err) {
            console.warn(
              `[policy-engine] Invalid condition in rule "${rule.name}" from ${src.path}: ${err}`
            );
            // Skip invalid rules rather than crash
            continue;
          }
          // Mark default policy rules as immutable
          if (src.isDefault) {
            rule.immutable = true;
          }
          rules.push(rule);
        }
      }
    } catch (err) {
      console.warn(`[policy-engine] Failed to load ${src.path}: ${err}`);
    }
  }

  // Verify policy integrity via checksum
  if (allYamlContent.length > 0) {
    const combinedContent = allYamlContent.join("\n---\n");
    const checksumResult = verifyChecksum(combinedContent);
    if (checksumResult) {
      _integrityWarning = checksumResult;
      console.warn(`[policy-engine] WARNING: ${checksumResult}`);
    }
  }

  _policies = rules;
  _parsedConditions = parsed;
  _loaded = true;
  return rules;
}

/**
 * Add a rule at runtime (e.g. from agent configuration).
 *
 * Rejects any "allow" rule that targets the same action as an immutable "block" rule.
 * This prevents runtime overrides of default security policies.
 */
export function addPolicy(rule: PolicyRule): void {
  if (!_loaded) loadPolicies();

  // Validate at add time - throws if invalid
  const parsed = parseCondition(rule.condition);

  // Security: reject allow rules that would override immutable block rules
  if (rule.decision === "allow") {
    const immutableBlocks = _policies.filter(
      (r) => r.immutable && r.decision === "block" && (r.action === rule.action || r.action === "*" || rule.action === "*")
    );
    if (immutableBlocks.length > 0) {
      const blockNames = immutableBlocks.map((r) => r.name).join(", ");
      throw new Error(
        `[policy-engine] Cannot add allow rule "${rule.name}" - it would override immutable block rule(s): ${blockNames}`
      );
    }
  }

  // Runtime rules are never immutable
  rule.immutable = false;

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
 * Evaluation order (blocks take priority over allows):
 *   1. Disabled rules skipped
 *   2. "block" rules checked first - if matched, hard deny (no override possible)
 *   3. "require_approval" rules checked - if matched, soft deny
 *   4. "allow" rules checked - if matched, explicitly allowed
 *   5. Default: allowed
 */
export function evaluatePolicy(
  action: PolicyActionType | string,
  context: PolicyContext
): PolicyDecision {
  if (!_loaded) loadPolicies();

  const agentId = context.agentId as string | undefined;

  const applicable = _policies.filter(
    (r) =>
      (r.enabled !== false) &&
      (r.action === action || r.action === "*") &&
      // Agent scope: rule applies if no scope (global) or scope matches agent
      (!r.agentScope || r.agentScope === agentId)
  );

  // Build index-aware list for pre-parsed condition lookup
  const withIndex = applicable.map((r) => ({
    rule: r,
    index: _policies.indexOf(r),
  }));

  // 1. Hard block - checked FIRST, blocks always win
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "block")) {
    if (evaluateCondition(index, rule.condition, context)) {
      return { allowed: false, reason: `[${rule.name}] ${rule.message}` };
    }
  }

  // 2. Soft deny (requires user approval)
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "require_approval")) {
    if (evaluateCondition(index, rule.condition, context)) {
      return {
        allowed: false,
        reason: `[${rule.name}] ${rule.message}`,
        requiresApproval: true,
      };
    }
  }

  // 3. Explicit allow
  for (const { rule, index } of withIndex.filter((r) => r.rule.decision === "allow")) {
    if (evaluateCondition(index, rule.condition, context)) {
      return { allowed: true };
    }
  }

  // Default: allow
  return { allowed: true };
}

// ============================================
// Convenience helpers
// ============================================

/**
 * Verify policy file integrity.
 * Returns whether stored checksum matches current policy files.
 */
export function verifyPolicies(): { valid: boolean; reason: string } {
  if (!_loaded) loadPolicies();

  if (_integrityWarning) {
    return { valid: false, reason: _integrityWarning };
  }

  return { valid: true, reason: "Policy checksums match" };
}

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

/**
 * Get all policy rules that apply to a specific agent.
 * Returns global rules (no agentScope) plus agent-specific rules.
 */
export function getAgentPolicy(agentId: string): PolicyRule[] {
  if (!_loaded) loadPolicies();
  return _policies.filter(
    (r) => (r.enabled !== false) && (!r.agentScope || r.agentScope === agentId)
  );
}

/**
 * Default restrictive policy rules for spawned/imported agents.
 * These block network, git push, and secret access unless explicitly overridden.
 */
export const SPAWNED_AGENT_RESTRICTIONS: PolicyRule[] = [
  {
    name: "spawned-no-network",
    action: "network_request",
    condition: "url contains .",
    decision: "block",
    message: "Spawned agents cannot make network requests by default.",
    agentScope: "__spawned__",
  },
  {
    name: "spawned-no-git-push",
    action: "git_push",
    condition: "branch contains ",
    decision: "block",
    message: "Spawned agents cannot push to git by default.",
    agentScope: "__spawned__",
  },
  {
    name: "spawned-no-secrets",
    action: "secret_write",
    condition: "key contains ",
    decision: "block",
    message: "Spawned agents cannot write secrets by default.",
    agentScope: "__spawned__",
  },
  {
    name: "spawned-no-env",
    action: "env_access",
    condition: "key contains ",
    decision: "block",
    message: "Spawned agents cannot access env vars by default.",
    agentScope: "__spawned__",
  },
];
