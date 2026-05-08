/**
 * 8gent Code - Agent Policy Engine (issue #2423)
 *
 * Per-agent YAML profiles declaring tool/data permissions, rate limits,
 * and output guardrails. Inspired by NemoClaw's declarative-guardrail
 * pattern. Layered ON TOP OF the rule-based PolicyEngine in
 * `policy-engine.ts`, not a replacement.
 *
 * Files live at `.8gent/policies/<agent>.yaml`. Inheritance resolves at
 * load time so the in-memory result is a single flattened policy.
 *
 * Self-custody: clients drop their own YAML in this directory and
 * the daemon enforces it. Human-readable, version-controlled, auditable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
	AgentPolicyCheckInput,
	AgentPolicyDecision,
	AgentPolicyFile,
	ResolvedAgentPolicy,
} from "./types.js";

// ============================================
// Path resolution
// ============================================

/** Resolve the policies directory. Order: explicit arg > env > default. */
export function resolvePoliciesDir(explicit?: string): string {
	if (explicit) return explicit;
	const fromEnv = process.env.EIGHT_POLICIES_DIR;
	if (fromEnv) return fromEnv;
	const dataDir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(dataDir, "policies");
}

/**
 * Repo-bundled policy directory shipped inside the package. Used as a
 * fallback when the user has not customised their policies and there is
 * no per-user YAML at `~/.8gent/policies/`.
 */
function bundledPoliciesDir(): string {
	const here = typeof __filename !== "undefined" ? __filename : new URL(import.meta.url).pathname;
	// packages/permissions/agent-policy.ts -> repo root .8gent/policies
	return path.resolve(path.dirname(here), "..", "..", ".8gent", "policies");
}

// ============================================
// Loader (with inheritance)
// ============================================

const MAX_INHERIT_DEPTH = 8;

function readPolicyFile(dir: string, name: string): AgentPolicyFile | null {
	const filePath = path.join(dir, `${name}.yaml`);
	if (!fs.existsSync(filePath)) return null;
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = parseYaml(raw) as AgentPolicyFile | null;
	return parsed ?? null;
}

/**
 * Load a single agent policy by name with inheritance resolution.
 * Looks first in `dir`, falls back to the repo-bundled defaults.
 *
 * Returns the flattened policy. Throws if a referenced file is missing
 * or if inheritance loops exceed MAX_INHERIT_DEPTH.
 */
export function loadAgentPolicy(name: string, dir?: string): ResolvedAgentPolicy {
	const userDir = resolvePoliciesDir(dir);
	const repoDir = bundledPoliciesDir();
	const seen: string[] = [];
	const chain: AgentPolicyFile[] = [];

	let cursor: string | undefined = name;
	while (cursor) {
		if (seen.includes(cursor)) {
			throw new Error(
				`[agent-policy] inheritance loop detected: ${[...seen, cursor].join(" -> ")}`,
			);
		}
		if (seen.length >= MAX_INHERIT_DEPTH) {
			throw new Error(`[agent-policy] inheritance chain too deep (max ${MAX_INHERIT_DEPTH})`);
		}
		seen.push(cursor);

		const fromUser = readPolicyFile(userDir, cursor);
		const file: AgentPolicyFile | null = fromUser ?? readPolicyFile(repoDir, cursor);
		if (!file) {
			throw new Error(`[agent-policy] policy "${cursor}" not found in ${userDir} or ${repoDir}`);
		}
		chain.push(file);
		cursor = file.inherit;
	}

	// Merge from base (last in chain) -> child (first). Child overrides base for
	// scalar fields; arrays are concatenated then de-duplicated. `deny` fields
	// always accumulate (security: a child cannot remove a parent's deny).
	const merged: ResolvedAgentPolicy = {
		agent: name,
		chain: [...seen],
		permissions: {
			tools: { allow: [], deny: [] },
			data: { read: [], write: [], deny: [] },
			rate_limits: {},
		},
		guardrails: {},
	};

	for (let i = chain.length - 1; i >= 0; i--) {
		const file = chain[i];
		const tools = file.permissions?.tools ?? {};
		const data = file.permissions?.data ?? {};
		const limits = file.permissions?.rate_limits ?? {};
		const guards = file.guardrails ?? {};

		// allow lists: child can narrow by setting its own; base provides default
		if (Array.isArray(tools.allow)) {
			merged.permissions.tools.allow =
				i === chain.length - 1
					? [...tools.allow]
					: dedupe([...merged.permissions.tools.allow, ...tools.allow]);
		}
		// deny is sticky and always accumulates
		if (Array.isArray(tools.deny)) {
			merged.permissions.tools.deny = dedupe([...merged.permissions.tools.deny, ...tools.deny]);
		}

		if (Array.isArray(data.read)) {
			merged.permissions.data.read = dedupe([...merged.permissions.data.read, ...data.read]);
		}
		if (Array.isArray(data.write)) {
			merged.permissions.data.write = dedupe([...merged.permissions.data.write, ...data.write]);
		}
		if (Array.isArray(data.deny)) {
			merged.permissions.data.deny = dedupe([...merged.permissions.data.deny, ...data.deny]);
		}

		if (typeof limits.prompts_per_minute === "number") {
			merged.permissions.rate_limits.prompts_per_minute = limits.prompts_per_minute;
		}
		if (typeof limits.tool_calls_per_minute === "number") {
			merged.permissions.rate_limits.tool_calls_per_minute = limits.tool_calls_per_minute;
		}

		if (typeof guards.max_output_tokens === "number") {
			merged.guardrails.max_output_tokens = guards.max_output_tokens;
		}
		if (Array.isArray(guards.require_approval_for)) {
			merged.guardrails.require_approval_for = dedupe([
				...(merged.guardrails.require_approval_for ?? []),
				...guards.require_approval_for,
			]);
		}
		if (Array.isArray(guards.blocked_patterns)) {
			merged.guardrails.blocked_patterns = dedupe([
				...(merged.guardrails.blocked_patterns ?? []),
				...guards.blocked_patterns,
			]);
		}
	}

	return merged;
}

function dedupe<T>(arr: T[]): T[] {
	return Array.from(new Set(arr));
}

// ============================================
// Path matching
// ============================================

/**
 * Match a target path against a list of glob-like prefixes. Supports
 * trailing `*` and `**`. Used for both allow and deny lists. Matching
 * is case-sensitive (filesystems vary; explicit is safer).
 */
function pathMatches(target: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const normalised = target.replace(/\\/g, "/");
	for (const pat of patterns) {
		if (matchOne(normalised, pat)) return true;
	}
	return false;
}

function matchOne(target: string, pattern: string): boolean {
	const pat = pattern.replace(/\\/g, "/");
	if (pat === target) return true;
	if (pat === "**" || pat === "*") return true;
	if (pat.endsWith("/**")) {
		const prefix = pat.slice(0, -3);
		return target === prefix || target.startsWith(`${prefix}/`);
	}
	if (pat.endsWith("/*")) {
		const prefix = pat.slice(0, -2);
		if (!target.startsWith(`${prefix}/`)) return false;
		return !target.slice(prefix.length + 1).includes("/");
	}
	if (pat.endsWith("*")) {
		return target.startsWith(pat.slice(0, -1));
	}
	return target.startsWith(`${pat}/`) || target === pat;
}

// ============================================
// Engine
// ============================================

interface RateBucket {
	count: number;
	windowStart: number;
}

/**
 * AgentPolicyEngine.
 *
 * One instance per agent. Holds the resolved policy plus an in-process
 * rate-limit counter. Stateless across restarts (rate limits reset).
 */
export class AgentPolicyEngine {
	readonly policy: ResolvedAgentPolicy;
	private toolCallBucket: RateBucket = { count: 0, windowStart: 0 };
	private promptBucket: RateBucket = { count: 0, windowStart: 0 };

	constructor(policy: ResolvedAgentPolicy) {
		this.policy = policy;
	}

	/** Convenience constructor: load by agent name. */
	static load(name: string, dir?: string): AgentPolicyEngine {
		return new AgentPolicyEngine(loadAgentPolicy(name, dir));
	}

	/**
	 * Check whether a tool action is permitted. Pure check — does NOT
	 * consume rate-limit budget. Call `recordToolCall()` separately on
	 * actual execution.
	 */
	checkAction(input: AgentPolicyCheckInput): AgentPolicyDecision {
		const { tool, path: targetPath, mode = "read", rawInput } = input;
		const { tools, data } = this.policy.permissions;
		const guards = this.policy.guardrails;

		if (tools.deny.includes(tool)) {
			return {
				allowed: false,
				reason: `tool "${tool}" denied by agent "${this.policy.agent}" policy`,
				category: "tool_denied",
			};
		}

		if (tools.allow.length > 0 && !tools.allow.includes(tool)) {
			return {
				allowed: false,
				reason: `tool "${tool}" not in allow-list for agent "${this.policy.agent}"`,
				category: "tool_denied",
			};
		}

		if (targetPath) {
			if (pathMatches(targetPath, data.deny)) {
				return {
					allowed: false,
					reason: `path "${targetPath}" denied by data.deny`,
					category: "data_denied",
				};
			}
			const scope = mode === "write" ? data.write : data.read;
			if (scope.length > 0 && !pathMatches(targetPath, scope)) {
				return {
					allowed: false,
					reason: `path "${targetPath}" not in data.${mode} scope`,
					category: "data_denied",
				};
			}
		}

		if (rawInput && Array.isArray(guards.blocked_patterns)) {
			const lower = rawInput.toLowerCase();
			for (const pat of guards.blocked_patterns) {
				if (pat && lower.includes(pat.toLowerCase())) {
					return {
						allowed: false,
						reason: `input contains blocked pattern "${pat}"`,
						category: "blocked_pattern",
					};
				}
			}
		}

		if (Array.isArray(guards.require_approval_for) && guards.require_approval_for.includes(tool)) {
			return {
				allowed: false,
				reason: `tool "${tool}" requires user approval`,
				category: "tool_denied",
				requiresApproval: true,
			};
		}

		return { allowed: true };
	}

	/** Check + consume one tool-call rate-limit slot. */
	checkRateLimit(kind: "tool_call" | "prompt", now: number = Date.now()): AgentPolicyDecision {
		const limit =
			kind === "tool_call"
				? this.policy.permissions.rate_limits.tool_calls_per_minute
				: this.policy.permissions.rate_limits.prompts_per_minute;
		if (typeof limit !== "number" || limit <= 0) return { allowed: true };

		const bucket = kind === "tool_call" ? this.toolCallBucket : this.promptBucket;
		if (now - bucket.windowStart >= 60_000) {
			bucket.windowStart = now;
			bucket.count = 0;
		}
		if (bucket.count >= limit) {
			const retryAfterMs = 60_000 - (now - bucket.windowStart);
			return {
				allowed: false,
				reason: `${kind} rate limit exceeded (${limit}/min, retry in ${retryAfterMs}ms)`,
				category: "rate_limited",
			};
		}
		bucket.count += 1;
		return { allowed: true };
	}

	/** Resolved guardrail value with sensible default. */
	maxOutputTokens(): number | undefined {
		return this.policy.guardrails.max_output_tokens;
	}
}

// ============================================
// Audit log (warn-only mode)
// ============================================

export interface AgentPolicyViolation {
	timestamp: number;
	agent: string;
	tool: string;
	path?: string;
	mode?: "read" | "write";
	reason: string;
	category: string;
	enforced: boolean;
}

/**
 * Append-only JSONL log. The daemon starts in warn-only mode: every
 * violation is logged, none are blocked. Once tuned, set
 * `EIGHT_AGENT_POLICY_ENFORCE=1` to flip to enforce mode.
 */
export function logViolation(violation: AgentPolicyViolation, logPath?: string): void {
	const dataDir = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	const target = logPath ?? path.join(dataDir, "agent-policy-violations.jsonl");
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.appendFileSync(target, `${JSON.stringify(violation)}\n`, "utf-8");
	} catch (err) {
		console.warn(`[agent-policy] failed to write violation log: ${err}`);
	}
}

/** Whether the daemon should block on violations or only log. */
export function isEnforcing(): boolean {
	return process.env.EIGHT_AGENT_POLICY_ENFORCE === "1";
}
