/**
 * 8gent Code - Policy Engine
 *
 * Lightweight YAML-driven policy evaluation for agent actions.
 * Governs file access, commands, git ops, network, and secrets.
 *
 * Inspired by NemoClaw (https://github.com/nemo-claw) — rebuilt from scratch in <200 lines.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type DecisionGate, logToolDecision } from "@8gent/audit";
import { parse as parseYaml } from "yaml";
import { resolveHome } from "../core/home.js";
import { type CapabilityRequest, enforceCapability } from "./capability-manifest.js";
import { scrubGoalText } from "./goal-secret-scrub.js";
import { commandTouchesAuditFiles, validatePath } from "./path-guard.js";
import { hasSecret } from "./secret-detector.js";
import { checkCommandBoundary, checkFilePathBoundary } from "./src/workspace-boundary.js";
import type {
	PolicyActionType,
	PolicyContext,
	PolicyDecision,
	PolicyFile,
	PolicyRule,
} from "./types.js";

// ============================================
// Constants
// ============================================

const DEFAULT_POLICY_PATH = path.join(
	path.dirname(typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url)),
	"default-policies.yaml",
);

const USER_POLICY_PATH = path.join(
	process.env.EIGHT_DATA_DIR || path.join(resolveHome(), ".8gent"),
	"policies.yaml",
);

const POLICY_CHECKSUM_PATH = path.join(
	process.env.EIGHT_DATA_DIR || path.join(resolveHome(), ".8gent"),
	"policy-checksum",
);

// ============================================
// Condition syntax validation
// ============================================

/** Max allowed length for regex-like patterns in conditions to prevent ReDoS */
const MAX_PATTERN_LENGTH = 200;

/** Valid condition operators */
const VALID_OPERATORS = [
	"contains",
	"in",
	"equals",
	"starts_with",
	"ends_with",
	"has_secret",
] as const;

type ConditionOperator = (typeof VALID_OPERATORS)[number];

interface ParsedClause {
	field: string;
	operator: ConditionOperator;
	value: string; // for contains, equals, starts_with, ends_with (unused by has_secret)
	values?: string[]; // for "in" operator
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
					`Invalid condition syntax: "${clause}". Expected: "field contains value", "field in [a, b]", "field equals value", "field starts_with value", "field ends_with value", or "field has_secret"`,
				);
			}
			andClauses.push(parsed);
		}

		orGroups.push(andClauses);
	}

	return { orGroups };
}

function parseClause(clause: string): ParsedClause | null {
	// "field has_secret" - credential-shaped value (see secret-detector.ts).
	// Matches key formats and high-entropy assignments, not the bare words
	// "token" or "secret", so prose and docs are not blocked.
	const secretMatch = clause.match(/^(\w+)\s+has_secret$/i);
	if (secretMatch) {
		return { field: secretMatch[1], operator: "has_secret", value: "" };
	}

	// "field contains value"
	const containsMatch = clause.match(/^(\w+)\s+contains\s+(.+)$/i);
	if (containsMatch) {
		const value = containsMatch[2].trim();
		if (value.length > MAX_PATTERN_LENGTH) {
			throw new Error(
				`Pattern too long (max ${MAX_PATTERN_LENGTH} chars): "${value.slice(0, 50)}..."`,
			);
		}
		return { field: containsMatch[1], operator: "contains", value };
	}

	// "field in [a, b, c]"
	const inMatch = clause.match(/^(\w+)\s+in\s+\[([^\]]*)\]$/i);
	if (inMatch) {
		const values = inMatch[2]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return { field: inMatch[1], operator: "in", value: "", values };
	}

	// "field equals value"
	const equalsMatch = clause.match(/^(\w+)\s+equals\s+(.+)$/i);
	if (equalsMatch) {
		return {
			field: equalsMatch[1],
			operator: "equals",
			value: equalsMatch[2].trim(),
		};
	}

	// "field starts_with value"
	const startsMatch = clause.match(/^(\w+)\s+starts_with\s+(.+)$/i);
	if (startsMatch) {
		return {
			field: startsMatch[1],
			operator: "starts_with",
			value: startsMatch[2].trim(),
		};
	}

	// "field ends_with value"
	const endsMatch = clause.match(/^(\w+)\s+ends_with\s+(.+)$/i);
	if (endsMatch) {
		return {
			field: endsMatch[1],
			operator: "ends_with",
			value: endsMatch[2].trim(),
		};
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
		fs.writeFileSync(POLICY_CHECKSUM_PATH, `${hash}\n`);
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
							`[policy-engine] Invalid condition in rule "${rule.name}" from ${src.path}: ${err}`,
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
			(r) =>
				r.immutable &&
				r.decision === "block" &&
				(r.action === rule.action || r.action === "*" || rule.action === "*"),
		);
		if (immutableBlocks.length > 0) {
			const blockNames = immutableBlocks.map((r) => r.name).join(", ");
			throw new Error(
				`[policy-engine] Cannot add allow rule "${rule.name}" - it would override immutable block rule(s): ${blockNames}`,
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
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
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
 *   "field has_secret"   (credential shapes, case-sensitive, see secret-detector.ts)
 *   Clauses joined by "and" (all must match) or "or" (any must match)
 *
 * All comparisons except has_secret are case-insensitive.
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
		andClauses.every((clause) => evaluateClauseParsed(clause, context)),
	);
}

function evaluateClauseParsed(clause: ParsedClause, context: PolicyContext): boolean {
	const rawValue = context[clause.field];

	// Runs on the ORIGINAL case: AKIA..., ghp_..., PEM headers are case-bound.
	if (clause.operator === "has_secret") return hasSecret(coerceToString(rawValue));

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
// COPPA hard-deny (not overridable by YAML)
// ============================================

/**
 * Actions that are gated by age. Email and address issuance for any account
 * flagged as 8gent Jr or under 13 is a hard deny - no YAML rule can lift it.
 * See PRD: docs/specs/PRD-AGENT-MESSAGING-AND-EMAIL.md (Security considerations).
 */
const COPPA_GATED_ACTIONS = new Set<string>(["email_send", "email_receive", "issue_email_address"]);

/**
 * COPPA gate. Returns a block decision if the context indicates a child
 * account, otherwise null (continue with normal policy eval).
 *
 * Triggers on:
 *   - context.product === "8gentjr"
 *   - context.account_age_verified_13_plus !== true (default deny without proof)
 */
function coppaGate(action: string, context: PolicyContext): PolicyDecision | null {
	if (!COPPA_GATED_ACTIONS.has(action)) return null;

	const isJr = context.product === "8gentjr";
	const ageProven = context.account_age_verified_13_plus === true;

	if (isJr || !ageProven) {
		return {
			allowed: false,
			reason:
				"[coppa-hard-deny] Email actions require a verified-13-plus account. " +
				"8gent Jr accounts are blocked unconditionally.",
		};
	}

	return null;
}

// ============================================
// Path guard hard-deny (issue #2465)
// ============================================

/**
 * Filesystem actions whose `path` field must clear the static path-guard
 * deny-list (credential dirs, UNC paths, device files, protected basenames).
 * Includes glob/list since those can enumerate sensitive locations too.
 */
const PATH_GUARDED_ACTIONS = new Set<string>([
	"read_file",
	"write_file",
	"delete_file",
	"edit_file",
	"apply_patch",
	"glob",
	"list_files",
]);

function pathGuardGate(action: string, context: PolicyContext): PolicyDecision | null {
	// Shell commands cannot be path-checked; refuse ones that name agent audit files (#3735).
	if (action === "run_command") {
		const command = typeof context.command === "string" ? context.command : "";
		if (command && commandTouchesAuditFiles(command)) {
			return { allowed: false, reason: "[path-guard] protected audit file named in command" };
		}
		return null;
	}
	if (!PATH_GUARDED_ACTIONS.has(action)) return null;
	const filePath = typeof context.path === "string" ? context.path : "";
	if (!filePath) return null;
	const cwd =
		(typeof context.workingDirectory === "string" && context.workingDirectory) ||
		(typeof context.workspaceRoot === "string" && context.workspaceRoot) ||
		process.cwd();
	const result = validatePath(filePath, cwd);
	if (!result.ok) {
		return { allowed: false, reason: `[path-guard] ${result.reason}: ${filePath}` };
	}
	return null;
}

// ============================================
// Workspace boundary hard-deny (issue #2083)
// ============================================

/** Actions whose rules may match `resolved_path` (#3474). */
const RESOLVED_PATH_ACTIONS = new Set<string>(["write_file", "delete_file"]);

/** Where a write to `p` lands: `~/` expanded, resolved against `cwd`, symlinks followed (#3474). */
export function resolvePolicyPath(p: string, cwd: string): string {
	const home = process.env.HOME;
	const expanded = home && (p === "~" || p.startsWith("~/")) ? path.join(home, p.slice(1)) : p;
	let cur = path.resolve(cwd, expanded);
	for (let hop = 0; hop < 8; hop++) {
		try {
			return fs.realpathSync(cur);
		} catch {}
		let full: string;
		try {
			full = path.join(fs.realpathSync(path.dirname(cur)), path.basename(cur));
		} catch {
			return cur;
		}
		let link: string;
		try {
			link = fs.readlinkSync(full);
		} catch {
			return full;
		}
		cur = path.resolve(path.dirname(full), link);
	}
	return cur;
}

/** Rules match where a write really lands too, not only the path as typed. */
function withResolvedPath(action: string, context: PolicyContext): PolicyContext {
	if (!RESOLVED_PATH_ACTIONS.has(action) || typeof context.path !== "string" || !context.path)
		return context;
	const cwd =
		(typeof context.cwd === "string" && context.cwd) ||
		(typeof context.workingDirectory === "string" && context.workingDirectory) ||
		process.cwd();
	// Rules match with forward slashes (`ends_with /.8gent/mcp.json`); a Windows path has backslashes.
	return {
		...context,
		resolved_path: resolvePolicyPath(context.path, cwd).split(path.sep).join("/"),
	};
}

/**
 * File-system actions whose `path` field must stay inside the workspace root.
 */
const FILE_BOUNDARY_ACTIONS = new Set<string>(["write_file", "read_file", "delete_file"]);

/**
 * Default absolute prefixes that legitimate commands are allowed to touch
 * even when they fall outside the workspace root (system binaries the agent
 * shells out to, plus the user's writable home for tooling like git config).
 * Callers can override via `context.allowedAbsolutePrefixes`.
 */
const DEFAULT_ALLOWED_PREFIXES = [
	"/usr/bin",
	"/usr/local/bin",
	"/usr/local/lib",
	"/usr/local/share",
	"/bin",
	"/opt/homebrew/bin",
	"/opt/homebrew/lib",
	"/opt/homebrew/share",
	os.tmpdir(),
];

function resolveWorkspaceRoot(context: PolicyContext): string | null {
	const fromContext = context.workspaceRoot;
	if (typeof fromContext === "string" && fromContext.length > 0) return fromContext;
	const fromEnv = process.env.EIGHT_WORKSPACE_ROOT;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return null;
}

function resolveAllowedPrefixes(context: PolicyContext): string[] {
	const fromContext = context.allowedAbsolutePrefixes;
	if (Array.isArray(fromContext)) {
		return [...DEFAULT_ALLOWED_PREFIXES, ...fromContext.filter((s) => typeof s === "string")];
	}
	return DEFAULT_ALLOWED_PREFIXES;
}

/**
 * Pre-check gate that resolves paths through `realpathSync` and rejects any
 * resolved path outside the workspace. Runs BEFORE YAML rule evaluation, so
 * a misconfigured allow rule can't lift the boundary.
 *
 * Skipped when no workspace root is set (CLI startup, daemons that opt out)
 * so existing tooling keeps working until a root is wired in.
 */
function workspaceBoundaryGate(action: string, context: PolicyContext): PolicyDecision | null {
	const workspaceRoot = resolveWorkspaceRoot(context);
	if (!workspaceRoot) return null;

	const allowedPrefixes = resolveAllowedPrefixes(context);

	if (FILE_BOUNDARY_ACTIONS.has(action)) {
		const filePath = typeof context.path === "string" ? context.path : "";
		if (!filePath) return null;
		const result = checkFilePathBoundary(filePath, workspaceRoot, allowedPrefixes);
		if (!result.allowed) {
			const v = result.violations[0];
			return {
				allowed: false,
				reason: `[workspace-boundary] ${v.reason}: ${v.raw} -> ${v.resolved}`,
			};
		}
	}

	if (action === "run_command") {
		const command = typeof context.command === "string" ? context.command : "";
		if (!command) return null;
		const result = checkCommandBoundary(command, workspaceRoot, allowedPrefixes);
		if (!result.allowed) {
			const v = result.violations[0];
			return {
				allowed: false,
				reason: `[workspace-boundary] ${v.reason}: ${v.raw} -> ${v.resolved}`,
			};
		}
	}

	return null;
}

// ============================================
// Shadow-candidate hard-deny (issue #2699, 8SO P0-3)
// ============================================

/**
 * The agent scope a hedge/shadow LOSER candidate runs under. Shadow
 * candidates may READ and COMPUTE only - they can NEVER reach a
 * side-effecting tool. Exactly one winner is chosen, then the winner
 * (NOT the shadow) re-executes side effects under the normal policy path.
 *
 * This mirrors `SPAWNED_AGENT_RESTRICTIONS` but is enforced as a hard
 * PRE-GATE (not a YAML rule), so no `addPolicy`/YAML allow can ever lift it.
 */
export const SHADOW_AGENT_SCOPE = "__shadow__";

/**
 * Every side-effecting action class. A `__shadow__`-scoped agent attempting
 * any of these is hard-denied before YAML rule eval. Read/compute-shaped
 * actions (read_file, glob, list_files) are deliberately absent - shadows
 * may observe and compute, they just cannot change the world.
 */
const SHADOW_DENIED_ACTIONS = new Set<string>([
	"write_file",
	"delete_file",
	"edit_file",
	"apply_patch",
	"run_command",
	"git_push",
	"git_commit",
	"network_request",
	"secret_write",
	"env_access",
	"email_send",
	"email_receive",
	"issue_email_address",
	"agent_mail_send",
	"peers_send",
	"computer_use",
	"desktop_use",
	// An MCP server can do anything its author wrote (#3230).
	"mcp_call",
	// A paired device can change the physical world (8DK, #3362).
	"device_use",
]);

/**
 * Action classes whose default, when no rule matches, is "ask the person"
 * rather than allow (#3213). Desktop control reaches every app the person
 * has open, so an unlisted desktop action must never run silently.
 */
const ASK_BY_DEFAULT_ACTIONS = new Set<string>([
	"desktop_use",
	// MCP tool calls reach a third-party server that can write, send and
	// spend (#3230). With no rule naming the tool as allowed, the person is
	// asked; Infinite skips the card in the caller, as for desktop_use.
	"mcp_call",
]);

/**
 * Shadow hard-deny gate. If the context agent is the shadow scope and the
 * action is side-effecting, deny unconditionally. Read/compute actions fall
 * through to the normal gates (which still apply path-guard etc).
 */
function shadowGate(action: string, context: PolicyContext): PolicyDecision | null {
	const agentId = typeof context.agentId === "string" ? context.agentId : "";
	if (agentId !== SHADOW_AGENT_SCOPE) return null;
	if (!SHADOW_DENIED_ACTIONS.has(action)) return null;
	return {
		allowed: false,
		reason: `[shadow-deny] shadow/hedge candidate (scope __shadow__) attempted side-effecting action "${action}". Shadow candidates run text/plan-only; only the chosen winner re-executes side effects under the normal policy path.`,
	};
}

// ============================================
// Core Evaluator
// ============================================

/**
 * Evaluate all loaded policies for a given action + context.
 *
 * Evaluation order (blocks take priority over allows):
 *   0a. Path guard - credential / UNC / device deny-list (issue #2465, not YAML-overridable)
 *   0b. COPPA hard-deny - email/address-issuance for child accounts (not YAML-overridable)
 *   0c. Workspace boundary - realpath-anchored confinement (issue #2083, not YAML-overridable)
 *   0d. Shadow-candidate hard-deny - __shadow__ scope cannot side-effect (issue #2699, not YAML-overridable)
 *   1. Disabled rules skipped
 *   2. "block" rules checked first - if matched, hard deny (no override possible)
 *   3. "require_approval" rules checked - if matched, soft deny
 *   4. "allow" rules checked - if matched, explicitly allowed
 *   5. Default: allowed, EXCEPT the action classes in ASK_BY_DEFAULT_ACTIONS,
 *      which require the person's approval when no rule matched (#3213)
 */
export function evaluatePolicy(
	action: PolicyActionType | string,
	given: PolicyContext,
): PolicyDecision {
	const context = withResolvedPath(action, given);
	const guard = pathGuardGate(action, context);
	if (guard) return guard;

	const coppa = coppaGate(action, context);
	if (coppa) return coppa;

	const boundary = workspaceBoundaryGate(action, context);
	if (boundary) return boundary;

	// 0d. Shadow-candidate hard-deny (issue #2699, 8SO P0-3) - a __shadow__
	//     scoped agent may never reach a side-effecting tool. Pre-gate so no
	//     YAML/addPolicy allow can lift it.
	const shadow = shadowGate(action, context);
	if (shadow) return shadow;

	if (!_loaded) loadPolicies();

	const agentId = context.agentId as string | undefined;

	const applicable = _policies.filter(
		(r) =>
			r.enabled !== false &&
			(r.action === action || r.action === "*") &&
			// Agent scope: rule applies if no scope (global) or scope matches agent
			(!r.agentScope || r.agentScope === agentId),
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

	// Default: allow - except for action classes that act on the person's
	// machine outside the workspace. A desktop tool no rule speaks for (a new
	// tool, a policy file without the desktop rules) asks, never runs.
	if (ASK_BY_DEFAULT_ACTIONS.has(action)) {
		return {
			allowed: false,
			reason: `[${action}-default-ask] No policy rule covers this ${action} action, so it needs the person's approval.`,
			requiresApproval: true,
		};
	}
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
	return evaluatePolicy("write_file", {
		path: filePath,
		content: content ?? "",
	});
}

/** Quick check: is this command allowed? */
export function checkCommand(command: string): PolicyDecision {
	return evaluatePolicy("run_command", { command });
}

/**
 * Vector evaluation for parsed bash commands (issue #2466).
 *
 * Each capability is mapped to its appropriate PolicyActionType and evaluated
 * independently. The first hard-deny short-circuits and is returned. If every
 * capability is allowed, the result is allowed.
 *
 * Caller is the bash tool, which calls this BEFORE spawning. Path-based
 * capabilities flow through the existing path-guard gate automatically.
 */
export interface BashCapabilityLike {
	kind: "run_command" | "write_file" | "read_file";
	command?: string;
	path?: string;
}

export function evaluateCapabilities(
	caps: BashCapabilityLike[],
	agentId?: string,
	cwd?: string,
): PolicyDecision {
	for (const cap of caps) {
		// cwd: what a redirect's relative path resolves against (#3474).
		const ctx: PolicyContext = cwd ? { agentId, cwd } : { agentId };
		if (cap.command !== undefined) ctx.command = cap.command;
		if (cap.path !== undefined) ctx.path = cap.path;
		const decision = evaluatePolicy(cap.kind, ctx);
		if (!decision.allowed) return decision;
	}
	return { allowed: true };
}

/** Quick check: is pushing to this branch allowed? */
export function checkGitPush(branch: string): PolicyDecision {
	return evaluatePolicy("git_push", { branch });
}

/**
 * Capability-manifest-gated tool call evaluation (issue #2756 step 1).
 *
 * Order:
 *   1. The tool's capability manifest - a tool may only use capabilities it
 *      declared (fs scopes, network hosts, exec commands). No manifest or an
 *      undeclared capability is a structural deny, before any rule runs.
 *   2. The existing rule pipeline (path-guard, COPPA, workspace boundary,
 *      shadow gate, YAML policies) via evaluatePolicy.
 *
 * This is the entry point tool call sites migrate to so least-capability is
 * enforced by the engine, not by convention.
 *
 * Every decision - allow or deny, from either gate - is appended to the
 * tamper-evident @8gent/audit hash chain (issue #2756 step 3) with the
 * request detail secret-scrubbed first. A trail that cannot be written is
 * warn-and-continue by default; under AUDIT_STRICT=1 an unauditable call is
 * denied outright (fail closed).
 */
export function evaluateToolCall(
	toolName: string,
	request: CapabilityRequest,
	context: PolicyContext = {},
): PolicyDecision {
	const workingDirectory =
		typeof context.workingDirectory === "string" ? context.workingDirectory : undefined;

	let decision: PolicyDecision;
	let gate: DecisionGate;

	const capability = enforceCapability(toolName, request, { workingDirectory });
	if (!capability.allowed) {
		decision = capability;
		gate = "capability-manifest";
	} else {
		gate = "policy-rules";
		switch (request.kind) {
			case "fs_read":
				decision = evaluatePolicy("read_file", { ...context, path: request.path });
				break;
			case "fs_write":
				decision = evaluatePolicy("write_file", { ...context, path: request.path });
				break;
			case "network":
				decision = evaluatePolicy("network_request", { ...context, url: request.url });
				break;
			case "exec":
				decision = evaluatePolicy("run_command", { ...context, command: request.command });
				break;
		}
	}

	const audited = recordToolDecision(toolName, request, context, decision, gate);
	if (!audited && process.env.AUDIT_STRICT === "1") {
		return {
			allowed: false,
			reason:
				"audit trail unavailable and AUDIT_STRICT=1: refusing to execute an unauditable tool call",
		};
	}
	return decision;
}

/** Path, URL, or command of a capability request - the value worth auditing. */
function requestDetailOf(request: CapabilityRequest): string {
	switch (request.kind) {
		case "fs_read":
		case "fs_write":
			return request.path;
		case "network":
			return request.url;
		case "exec":
			return request.command;
	}
}

/**
 * Append one evaluateToolCall outcome to the decision audit chain.
 * Secrets are scrubbed out of the request detail BEFORE it is persisted so
 * the trail never becomes a credential store. Returns false when the trail
 * could not be written; the caller decides whether that is fatal.
 */
function recordToolDecision(
	toolName: string,
	request: CapabilityRequest,
	context: PolicyContext,
	decision: PolicyDecision,
	gate: DecisionGate,
): boolean {
	try {
		const { clean } = scrubGoalText(requestDetailOf(request));
		logToolDecision({
			tool: toolName,
			actor:
				typeof context.agentId === "string" && context.agentId.length > 0
					? context.agentId
					: "agent",
			requestKind: request.kind,
			requestDetail: clean,
			decision: decision.allowed ? "allow" : "deny",
			gate,
			reason: decision.allowed ? "allowed" : decision.reason,
			sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
		});
		return true;
	} catch (err) {
		console.warn(
			"[permissions] decision audit trail write failed:",
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

/**
 * Get all policy rules that apply to a specific agent.
 * Returns global rules (no agentScope) plus agent-specific rules.
 */
export function getAgentPolicy(agentId: string): PolicyRule[] {
	if (!_loaded) loadPolicies();
	return _policies.filter(
		(r) => r.enabled !== false && (!r.agentScope || r.agentScope === agentId),
	);
}

// ============================================
// /goal Capability Budget (issue #2609, epic #2605)
// ============================================

/**
 * Per-run capability budget. Every axis is enforced; the first axis to
 * exceed its cap kills the run with `exceeded:<axis>`.
 *
 * - maxWallclockMs:    cumulative elapsed ms since run start
 * - maxToolCalls:      total tool invocations attempted
 * - maxCloudUsd:       cumulative cloud-tier inference spend in USD
 * - maxFilesModified:  unique file paths the run has written or deleted
 * - maxEgressBytes:    cumulative outbound network bytes
 */
export interface CapabilityBudget {
	maxWallclockMs: number;
	maxToolCalls: number;
	maxCloudUsd: number;
	maxFilesModified: number;
	maxEgressBytes: number;
	/** Computer-use surfaces only: block financial domains, password fields, sudo. */
	financialDomainsBlocked?: boolean;
	passwordFieldsBlocked?: boolean;
	sudoBlocked?: boolean;
}

/**
 * Running counters tracked over the lifetime of a /goal run. Caller is
 * responsible for incrementing these as work happens; the evaluator only
 * compares them against the budget.
 */
export interface BudgetCounters {
	wallclockMs: number;
	toolCalls: number;
	cloudUsd: number;
	filesModified: number;
	egressBytes: number;
	/** Whether the current judge attempt is using a cloud-tier model. */
	currentAttemptCloudTier?: boolean;
	/** Pattern ids from goal-secret-scrub for the active run. */
	scrubbedSecretMarkers?: string[];
}

/**
 * Default TUI budget. Conservative caps so a runaway loop dies before it
 * eats the workspace.
 *
 *   2h wallclock, 500 tool calls, $0 cloud (local only), 50 files, 100MB egress.
 */
export const DEFAULT_TUI_BUDGET: CapabilityBudget = {
	maxWallclockMs: 2 * 60 * 60 * 1000,
	maxToolCalls: 500,
	maxCloudUsd: 0,
	maxFilesModified: 50,
	maxEgressBytes: 100 * 1024 * 1024,
};

/**
 * Default computer-use budget. Shorter wallclock, same other limits,
 * plus three hard switches: financial domains, password fields, sudo
 * are all blocked when computer-use is the active surface.
 */
export const DEFAULT_COMPUTER_USE_BUDGET: CapabilityBudget = {
	maxWallclockMs: 1 * 60 * 60 * 1000,
	maxToolCalls: 500,
	maxCloudUsd: 0,
	maxFilesModified: 50,
	maxEgressBytes: 100 * 1024 * 1024,
	financialDomainsBlocked: true,
	passwordFieldsBlocked: true,
	sudoBlocked: true,
};

export type BudgetEvalResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Evaluate the budget. Returns the first axis to breach (alphabetised
 * priority, but in practice "first match wins"). The runId argument is
 * carried for audit logging by callers; this function itself is pure.
 *
 * Also enforces cloud-failover-with-secrets: if the run has scrubbed
 * secret markers AND the current judge attempt is cloud-tier, the call
 * is blocked with `cloud-with-secrets-blocked`. No flag can override.
 */
export function evaluateBudget(
	runId: string,
	counters: BudgetCounters,
	budget: CapabilityBudget,
): BudgetEvalResult {
	// Hard safety: cloud-with-secrets, evaluated FIRST so a budget axis
	// breach doesn't mask the more severe secret-exfil risk.
	if (
		counters.currentAttemptCloudTier === true &&
		Array.isArray(counters.scrubbedSecretMarkers) &&
		counters.scrubbedSecretMarkers.length > 0
	) {
		return {
			allowed: false,
			reason: "cloud-with-secrets-blocked",
		};
	}

	if (counters.wallclockMs > budget.maxWallclockMs) {
		return { allowed: false, reason: "exceeded:wallclock" };
	}
	if (counters.toolCalls > budget.maxToolCalls) {
		return { allowed: false, reason: "exceeded:tool-calls" };
	}
	if (counters.cloudUsd > budget.maxCloudUsd) {
		return { allowed: false, reason: "exceeded:cloud-usd" };
	}
	if (counters.filesModified > budget.maxFilesModified) {
		return { allowed: false, reason: "exceeded:files-modified" };
	}
	if (counters.egressBytes > budget.maxEgressBytes) {
		return { allowed: false, reason: "exceeded:egress-bytes" };
	}

	// runId is carried for audit hooks; reference it so linters don't strip.
	void runId;

	return { allowed: true };
}

// ============================================
// Budget POLICY (issue #2699, 8GO section 3)
// ============================================

/**
 * The at-cap behaviour Agent A's ResourceGovernor reads. Policy fixes the
 * meaning per axis; the engine (Agent A) wires the counters.
 *
 * ADOPTED DEFAULTS (8GO):
 *   thermal ceiling   = HARD-HALT      (safety over completion, always)
 *   spend ceiling     = halt-and-ask   (never spend past the ceiling to finish)
 *   token/day ceiling = degrade-to-local (drop to a cheaper local model)
 *
 * A halt always leaves a signed, resumable state (the caller writes the
 * checkpoint; this enum tells it which response to take).
 */
export type BudgetAtCapAction = "degrade" | "ask" | "halt";

/**
 * Rolling ceilings layered on top of the per-run `CapabilityBudget`. These
 * track across runs (per-day token + spend) and against the host (thermal).
 * Agent A's ResourceGovernor owns the counters; policy owns the thresholds
 * and the at-cap action.
 */
export interface BudgetPolicy {
	/** Per-day token cap. Breach => degrade-to-local. */
	maxTokensPerDay: number;
	/** Per-day cloud spend ceiling in USD. Breach => halt-and-ask. */
	maxSpendPerDayUsd: number;
	/** Thermal / sustained-compute ceiling (0-100). Breach => hard-halt. */
	maxThermalPct: number;
	/** The at-cap action per axis. Fixed by policy; not caller-overridable up. */
	atCap: {
		token: BudgetAtCapAction;
		spend: BudgetAtCapAction;
		thermal: BudgetAtCapAction;
	};
}

/**
 * The adopted default budget policy. local-first => $0 default cloud spend.
 * The system may TIGHTEN these (more conservative) but never WIDEN them.
 */
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
	maxTokensPerDay: 2_000_000,
	maxSpendPerDayUsd: 0,
	maxThermalPct: 85,
	atCap: {
		token: "degrade",
		spend: "ask",
		thermal: "halt",
	},
};

export interface RollingBudgetCounters {
	tokensToday: number;
	spendTodayUsd: number;
	/** Current thermal / sustained-compute load, 0-100. */
	thermalPct: number;
}

export type BudgetPolicyResult =
	| { withinBudget: true }
	| {
			withinBudget: false;
			axis: "token" | "spend" | "thermal";
			action: BudgetAtCapAction;
			reason: string;
	  };

/**
 * Evaluate the rolling budget POLICY and return the at-cap action for the
 * first breached axis. Thermal is checked FIRST (a runaway / overheat is the
 * most severe), then spend (money), then tokens (cheapest to recover from).
 *
 * Pure function: it reads counters + policy and returns a verdict. Every
 * deny/degrade/halt MUST be audit-logged by the caller
 * (`{ts, op:"budget", runId, axis, action, counters}`); no budget event is
 * silent. `runId` is carried for that hook.
 */
export function evaluateBudgetPolicy(
	runId: string,
	counters: RollingBudgetCounters,
	policy: BudgetPolicy = DEFAULT_BUDGET_POLICY,
): BudgetPolicyResult {
	void runId; // carried for the caller's audit hook

	if (counters.thermalPct > policy.maxThermalPct) {
		return {
			withinBudget: false,
			axis: "thermal",
			action: policy.atCap.thermal,
			reason: `exceeded:thermal (${counters.thermalPct}% > ${policy.maxThermalPct}%) -> ${policy.atCap.thermal}`,
		};
	}
	if (counters.spendTodayUsd > policy.maxSpendPerDayUsd) {
		return {
			withinBudget: false,
			axis: "spend",
			action: policy.atCap.spend,
			reason: `exceeded:spend-per-day ($${counters.spendTodayUsd} > $${policy.maxSpendPerDayUsd}) -> ${policy.atCap.spend}`,
		};
	}
	if (counters.tokensToday > policy.maxTokensPerDay) {
		return {
			withinBudget: false,
			axis: "token",
			action: policy.atCap.token,
			reason: `exceeded:tokens-per-day (${counters.tokensToday} > ${policy.maxTokensPerDay}) -> ${policy.atCap.token}`,
		};
	}
	return { withinBudget: true };
}

/**
 * Reconcile a PROPOSED budget policy against the current one. The system may
 * TIGHTEN its own budget (every axis <= current) but may NEVER WIDEN it - a
 * wider envelope is a James decision (a rung-3 approval), not something the
 * flywheel grants itself. Returns the safe-merged policy: any axis the
 * proposal tried to widen is clamped back to the current (tighter) value.
 *
 * `widened` lists the axes that were clamped, so the caller can surface a
 * rung-3 card ("the system wanted more headroom - approve?").
 */
export function reconcileBudgetPolicy(
	current: BudgetPolicy,
	proposed: Partial<BudgetPolicy>,
): { policy: BudgetPolicy; widened: string[] } {
	const widened: string[] = [];
	const clampDown = (axis: keyof BudgetPolicy, cur: number, next: number | undefined): number => {
		if (typeof next !== "number") return cur;
		if (next > cur) {
			widened.push(String(axis));
			return cur; // refuse to widen - keep the tighter current value
		}
		return next; // tightening is always allowed
	};
	return {
		policy: {
			maxTokensPerDay: clampDown(
				"maxTokensPerDay",
				current.maxTokensPerDay,
				proposed.maxTokensPerDay,
			),
			maxSpendPerDayUsd: clampDown(
				"maxSpendPerDayUsd",
				current.maxSpendPerDayUsd,
				proposed.maxSpendPerDayUsd,
			),
			maxThermalPct: clampDown("maxThermalPct", current.maxThermalPct, proposed.maxThermalPct),
			// at-cap actions are policy-fixed; a proposal cannot soften them.
			atCap: current.atCap,
		},
		widened,
	};
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

/**
 * Shadow-candidate restriction rules (issue #2699). These mirror the
 * SPAWNED set for the `__shadow__` scope. The hard `shadowGate` pre-gate is
 * the primary enforcement; these YAML-shaped rules are belt-and-suspenders
 * for callers that load them via `addPolicy`. A shadow candidate may read
 * and compute, but never write, push, send, or exec.
 */
export const SHADOW_AGENT_RESTRICTIONS: PolicyRule[] = [
	{
		name: "shadow-no-write",
		action: "write_file",
		condition: "path contains ",
		decision: "block",
		message:
			"Shadow/hedge candidates cannot write files. Only the chosen winner re-executes side effects.",
		agentScope: SHADOW_AGENT_SCOPE,
	},
	{
		name: "shadow-no-command",
		action: "run_command",
		condition: "command contains ",
		decision: "block",
		message: "Shadow/hedge candidates cannot run commands.",
		agentScope: SHADOW_AGENT_SCOPE,
	},
	{
		name: "shadow-no-network",
		action: "network_request",
		condition: "url contains .",
		decision: "block",
		message: "Shadow/hedge candidates cannot make network requests.",
		agentScope: SHADOW_AGENT_SCOPE,
	},
	{
		name: "shadow-no-git-push",
		action: "git_push",
		condition: "branch contains ",
		decision: "block",
		message: "Shadow/hedge candidates cannot push to git.",
		agentScope: SHADOW_AGENT_SCOPE,
	},
	{
		name: "shadow-no-send",
		action: "email_send",
		condition: "to contains ",
		decision: "block",
		message: "Shadow/hedge candidates cannot send mail.",
		agentScope: SHADOW_AGENT_SCOPE,
	},
];
