/**
 * ToolG8 - Gate middleware for all tool calls.
 *
 * Wraps every tool execution through NemoClaw policy evaluation.
 * Logs every gate decision to audit trail for traceability.
 *
 * Part of the G8WAY governance layer (#988).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BashGateResult, gateBashCommand } from "../tools/bash-tool.js";
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

/**
 * Per-segment bash gate trace attached to the audit entry for run_command.
 * `denied` reflects the SEGMENT check only; the final gate decision is the
 * AND of the whole-string check and this one (belt-and-braces).
 */
export interface BashGateAudit {
	denied: boolean;
	reason?: string;
	capabilityCount: number;
	capabilities: Array<{
		kind: string;
		command?: string;
		path?: string;
		source: string;
	}>;
	/** Set when the bash parser threw; the gate fell back to whole-string evaluation. */
	parserError?: string;
}

type BashGateFn = (command: string, agentId?: string) => BashGateResult;

/** Cap the number of capabilities written per audit entry to keep JSONL lean. */
const AUDIT_MAX_CAPABILITIES = 50;

interface AuditEntry {
	timestamp: string;
	agentId: string;
	action: PolicyActionType;
	context: Record<string, unknown>;
	allowed: boolean;
	reason?: string;
	/** Present for run_command gates: per-segment bash evaluation trace. */
	bash?: BashGateAudit;
}

// ============================================
// Audit log path
// ============================================

const AUDIT_DIR = path.join(
	process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
	"audit",
);
const AUDIT_PATH = path.join(AUDIT_DIR, "toolg8.jsonl");

/**
 * Absolute path of the gate audit JSONL, resolved once at module load.
 * Exposed so tests and ops tooling read the SAME file the gate writes,
 * regardless of later EIGHT_DATA_DIR mutations.
 */
export function getAuditPath(): string {
	return AUDIT_PATH;
}

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

		// Belt-and-braces bash segment gate (issue #2782, wiring for #2466).
		// The whole-string check above cannot see through compound commands
		// ("echo hi && DENIED"), subshells ("echo $(DENIED)"), or redirection
		// write targets ("ls > /etc/passwd" is a write_file, not a run_command).
		// gateBashCommand parses the command and evaluates every segment,
		// subshell (recursive), and redirection target against the policy
		// engine. Deny if EITHER check denies - the segment gate can only
		// tighten, never loosen, the whole-string decision.
		let bash: BashGateAudit | undefined;
		if (
			action === "run_command" &&
			typeof context.command === "string" &&
			context.command.trim().length > 0
		) {
			bash = this.gateBashSegments(context.command, agentId);
		}

		const allowed = decision.allowed && !bash?.denied;

		const result: GateResult = { allowed };

		if (!allowed) {
			if (!decision.allowed && "reason" in decision) {
				result.reason = decision.reason;
			} else if (bash?.denied) {
				result.reason = `[bash-segment] ${bash.reason ?? "denied by per-segment policy"}`;
			}
			// The generic write_file hint ("use edit_file with targeted
			// replacements") is misleading for a secrets block: the problem is
			// the content, not the write method, and the rule's own message
			// already says what to do (.env + process.env).
			result.alternative = result.reason?.includes("[no-secrets-in-files]")
				? undefined
				: this.suggestAlternative(action);
		}

		// Audit log (fire-and-forget, never blocks)
		this.audit(agentId, action, context, result, bash);

		return result;
	}

	/**
	 * Run the per-segment bash gate and shape the result for audit.
	 *
	 * FAIL-SAFE, NOT FAIL-OPEN: if the parser throws, this returns
	 * `denied: false` with `parserError` set - the whole-string evaluation in
	 * gate() has already run and remains authoritative, so a parser fault can
	 * never grant MORE access than the legacy check, and it is never silent
	 * (the parserError lands in the audit JSONL).
	 */
	private gateBashSegments(command: string, agentId: string): BashGateAudit {
		try {
			const { decision, capabilities } = this.bashGateFn(command, agentId);
			return {
				denied: !decision.allowed,
				reason: !decision.allowed && "reason" in decision ? decision.reason : undefined,
				capabilityCount: capabilities.length,
				capabilities: capabilities.slice(0, AUDIT_MAX_CAPABILITIES).map((c) => ({
					kind: c.kind,
					command: truncateForAudit(c.command),
					path: truncateForAudit(c.path),
					source: c.source,
				})),
			};
		} catch (err) {
			return {
				denied: false,
				capabilityCount: 0,
				capabilities: [],
				parserError: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/** The segment gate implementation. Swappable ONLY for tests (parser-fault path). */
	private bashGateFn: BashGateFn = gateBashCommand;

	/**
	 * TEST ONLY - simulate a bash parser fault to prove the fail-safe fallback.
	 * Passing null restores the real gateBashCommand. Never call in production
	 * code paths; the segment gate must stay live.
	 */
	_setBashGateForTest(fn: BashGateFn | null): void {
		this.bashGateFn = fn ?? gateBashCommand;
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
		result: GateResult,
		bash?: BashGateAudit,
	): void {
		try {
			if (!fs.existsSync(AUDIT_DIR)) {
				fs.mkdirSync(AUDIT_DIR, { recursive: true });
			}

			// Strip content field to keep audit log lean
			const safeContext: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(context)) {
				if (k === "content") continue;
				safeContext[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v;
			}

			const entry: AuditEntry = {
				timestamp: new Date().toISOString(),
				agentId,
				action,
				context: safeContext,
				allowed: result.allowed,
				reason: result.reason,
			};
			if (bash) {
				entry.bash = bash;
			}

			fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(entry)}\n`);
		} catch {
			// Silent - audit failure must never block execution
		}
	}
}

/** Truncate a capability string for the audit JSONL (same 200-char cap as context). */
function truncateForAudit(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}
