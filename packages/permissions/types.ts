/**
 * 8gent Code - Permission + Policy Types
 *
 * Extends the base permission system with structured policy rules.
 * Policy engine inspired by NemoClaw (https://github.com/nemo-claw) — rebuilt from scratch.
 */

// ============================================
// Existing permission types (re-exported)
// ============================================

export type {
	PermissionConfig,
	PermissionRequest,
	PermissionLog,
} from "./index.js";

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
	| "secret_write"
	| "agent_mail_send"
	| "agent_mail_read"
	| "peers_send"
	| "peers_subscribe"
	| "email_send"
	| "email_receive"
	| "issue_email_address";

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
	/** Agent scope - if set, rule only applies to matching agent IDs. Empty/undefined = global (all agents). */
	agentScope?: string;
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
	/** Agent ID for per-agent policy scoping */
	agentId?: string;
	/** Freeform extra fields */
	[key: string]: unknown;
}

// ============================================
// Agent Policy (issue #2423)
// ============================================
//
// Higher-level declarative agent profile, layered on top of the rule-based
// PolicyEngine. The PolicyEngine answers "is this exact action with this
// context allowed?". AgentPolicy answers "what is this agent allowed to do
// at all? what are its limits?".
//
// One YAML file per agent in `.8gent/policies/<name>.yaml`. Inheritance via
// `inherit: <name>` resolves at load time. Client deployments customise by
// dropping their own YAML in the same directory.

export interface AgentPolicyToolPermissions {
	/** Whitelist of tool names this agent may call. Empty/missing = allow all (subject to deny). */
	allow?: string[];
	/** Blacklist of tool names this agent may not call. Always wins over allow. */
	deny?: string[];
}

export interface AgentPolicyDataPermissions {
	/** Glob-like prefixes the agent may read. */
	read?: string[];
	/** Glob-like prefixes the agent may write. */
	write?: string[];
	/** Glob-like prefixes the agent must not touch (always wins). */
	deny?: string[];
}

export interface AgentPolicyRateLimits {
	prompts_per_minute?: number;
	tool_calls_per_minute?: number;
}

export interface AgentPolicyGuardrails {
	max_output_tokens?: number;
	/** Tool names that must be explicitly approved by the user before execution. */
	require_approval_for?: string[];
	/** Substrings (case-insensitive) that, if found in tool input, must be blocked. */
	blocked_patterns?: string[];
}

/** Top-level agent policy file structure. */
export interface AgentPolicyFile {
	version?: string | number;
	/** Agent name this policy applies to (informational). */
	agent?: string;
	/** Name of another agent policy file (without .yaml) to inherit from. */
	inherit?: string;
	permissions?: {
		tools?: AgentPolicyToolPermissions;
		data?: AgentPolicyDataPermissions;
		rate_limits?: AgentPolicyRateLimits;
	};
	guardrails?: AgentPolicyGuardrails;
}

/** Resolved (post-inheritance) agent policy. */
export interface ResolvedAgentPolicy {
	agent: string;
	chain: string[]; // inheritance chain, base last
	permissions: {
		tools: Required<AgentPolicyToolPermissions>;
		data: Required<AgentPolicyDataPermissions>;
		rate_limits: AgentPolicyRateLimits;
	};
	guardrails: AgentPolicyGuardrails;
}

/** Input to AgentPolicyEngine.checkAction(). */
export interface AgentPolicyCheckInput {
	tool: string;
	/** Optional file path the tool is targeting. */
	path?: string;
	/** Whether the tool is reading or writing. Defaults to "read". */
	mode?: "read" | "write";
	/** Optional raw input to scan for blocked_patterns. */
	rawInput?: string;
}

export type AgentPolicyDecision =
	| { allowed: true }
	| {
			allowed: false;
			reason: string;
			category: "tool_denied" | "data_denied" | "blocked_pattern" | "rate_limited";
			requiresApproval?: boolean;
	  };
