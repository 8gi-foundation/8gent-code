/**
 * Maker-Checker Enforcement (execution-path wiring)
 *
 * BACKGROUND
 * ----------
 * `packages/daemon/maker-checker.ts` defines the two-person rule
 * (MakerCheckerStore, DEFAULT_RULES, CheckerDecision) but until now it was
 * imported by nobody on the tool-execution path. Destructive tools (rm,
 * git_push, vercel_deploy, vercel_set_env, enable_infinite_mode) therefore ran
 * UNGATED whenever the autonomy engine dispatched unattended.
 *
 * This module is the missing wire. It sits at the single tool-execution
 * chokepoint (`ToolExecutor.executeRaw` in packages/eight/tools.ts) and, when
 * the executor runs in an UNATTENDED/autonomous context, refuses to run a
 * destructive tool unless an APPROVED CheckerDecision exists for it.
 *
 * DESIGN NOTES
 * ------------
 * - Classification of "what is destructive" stays in the EXISTING rule engine
 *   (`MakerCheckerStore` seeded with `DEFAULT_RULES`). This module only
 *   *translates* a `toolName + args` pair into the `(action, risk)` tuple the
 *   rules already understand, and asks the store `requiresChecker(...)`. It
 *   does NOT hardcode a parallel "destructive tool" allow/deny list.
 * - The rule set is extended with two `addRule` calls (deploy:* and infinite:*)
 *   so vercel_deploy and enable_infinite_mode are covered, without mutating the
 *   shared `DEFAULT_RULES` array that other consumers read.
 * - Shell danger detection reuses the existing `isCommandDangerous` heuristic.
 * - Enforcement is CONFIG-GATED so it cannot wedge interactive use:
 *     * default: enforce only when the executor is `unattended`.
 *     * EIGHT_ENFORCE_CHECKER=1/true  -> force enforcement on (any context).
 *     * EIGHT_ENFORCE_CHECKER=0/false -> force enforcement off (kill switch).
 */

import { ACTION_RISK, AUTONOMY_RUNG, type ActionRisk } from "../daemon/autonomy";
import { ACTION_STATUS, MakerCheckerStore } from "../daemon/maker-checker";
import { isCommandDangerous, isProtectedBranchName } from "./index";

/** Typed error thrown when a destructive tool is blocked pending approval. */
export class MakerCheckerBlockedError extends Error {
	readonly code = "MAKER_CHECKER_BLOCKED" as const;
	constructor(
		public readonly toolName: string,
		public readonly action: string,
		public readonly risk: ActionRisk,
		public readonly actionId: string,
		message: string,
	) {
		super(message);
		this.name = "MakerCheckerBlockedError";
	}
}

/**
 * Shared enforcement store. Seeded from DEFAULT_RULES (via MakerCheckerStore's
 * constructor) plus deploy/infinite coverage. A single instance so an approval
 * recorded by a checker surface (or a red-team test) is visible to the guard.
 */
let sharedStore: MakerCheckerStore | null = null;
/** actionId -> action string, so an approval can be matched back to a retry. */
let actionIndex = new Map<string, string>();
/** actionIds whose approval has already been consumed (one-shot). */
let consumed = new Set<string>();

export function getMakerCheckerStore(): MakerCheckerStore {
	if (!sharedStore) {
		sharedStore = new MakerCheckerStore();
		// Extend the rule set (does not touch the exported DEFAULT_RULES array).
		sharedStore.addRule({
			actionPattern: "deploy:*",
			minRisk: ACTION_RISK.RISKY,
			checkerMode: "human",
			requiredRung: AUTONOMY_RUNG.AUTONOMOUS,
			timeoutMs: 30 * 60 * 1000,
			notifyOwner: true,
		});
		sharedStore.addRule({
			actionPattern: "infinite:*",
			minRisk: ACTION_RISK.RISKY,
			checkerMode: "human",
			requiredRung: AUTONOMY_RUNG.AUTONOMOUS,
			timeoutMs: 30 * 60 * 1000,
			notifyOwner: true,
		});
	}
	return sharedStore;
}

/** Test/boot helper: reset the shared store and its indices. */
export function resetMakerCheckerEnforcer(): void {
	sharedStore = null;
	actionIndex = new Map();
	consumed = new Set();
}

/**
 * Translate a tool invocation into the `(action, risk)` tuple understood by the
 * maker-checker rules. Returns null for tools that carry no destructive risk
 * (reads, listings, search, benign shell) — those are never gated.
 *
 * This is a translation layer, not a policy: whether a returned tuple actually
 * requires a checker is decided by `store.requiresChecker(...)`.
 */
export function classifyToolAction(
	toolName: string,
	args: Record<string, unknown>,
	cwd?: string,
): { action: string; risk: ActionRisk } | null {
	switch (toolName) {
		case "git_push": {
			// The executor resolves the branch the push lands on into `branch`
			// and sets `protectedPush` when it is main/master or unknown.
			const branch = String(args.branch ?? "").trim() || "current";
			const isMain = isProtectedBranchName(branch) || branch === "*" || args.protectedPush === true;
			return {
				action: `git:push:${branch}`,
				risk: isMain ? ACTION_RISK.DESTRUCTIVE : ACTION_RISK.RISKY,
			};
		}
		case "delete_file":
			return {
				action: `file:delete:${String(args.path ?? "")}`,
				risk: ACTION_RISK.RISKY,
			};
		case "vercel_deploy":
			return { action: "deploy:vercel", risk: ACTION_RISK.RISKY };
		case "vercel_set_env":
			// Mutating production secrets == credential class == DESTRUCTIVE.
			return {
				action: `credential:vercel:${String(args.key ?? "")}`,
				risk: ACTION_RISK.DESTRUCTIVE,
			};
		case "enable_infinite_mode":
			return { action: "infinite:enable", risk: ACTION_RISK.RISKY };
		case "run_command":
		case "background_start": {
			const cmd = String(args.command ?? "");
			if (!cmd) return null;
			// Reuse the existing danger heuristic. Benign shell is not gated so
			// autonomous non-destructive work (ls, cat, grep, build) is unaffected.
			// isCommandDangerous includes protected-branch pushes, resolved in cwd.
			if (isCommandDangerous(cmd, cwd)) {
				return {
					action: `shell:${cmd.slice(0, 120)}`,
					risk: ACTION_RISK.DESTRUCTIVE,
				};
			}
			return null;
		}
		default:
			return null;
	}
}

/** Look for a still-valid approved decision for this action, consuming it. */
function findAndConsumeApproval(action: string): boolean {
	const store = getMakerCheckerStore();
	for (const [actionId, indexedAction] of actionIndex) {
		if (indexedAction !== action) continue;
		if (consumed.has(actionId)) continue;
		const decision = store.getDecision(actionId);
		if (decision && decision.status === ACTION_STATUS.APPROVED) {
			consumed.add(actionId);
			return true;
		}
	}
	return false;
}

export interface EnforceOptions {
	/** Whether the calling executor runs unattended (autonomous). */
	unattended: boolean;
	/** Identifier of the agent/vessel making the request. */
	makerId?: string;
	/** Directory the tool runs in, for resolving where a push lands. */
	cwd?: string;
}

/**
 * Decide whether enforcement is active for this context. Interactive callers
 * are never gated (unless EIGHT_ENFORCE_CHECKER forces it), so human-approved
 * flows cannot break.
 */
export function enforcementActive(unattended: boolean): boolean {
	const flag = (process.env.EIGHT_ENFORCE_CHECKER || "").trim().toLowerCase();
	if (flag === "0" || flag === "false") return false; // kill switch
	if (flag === "1" || flag === "true") return true; // force on
	return unattended;
}

/**
 * Enforce the maker-checker at the tool-execution chokepoint.
 *
 * Throws {@link MakerCheckerBlockedError} when a destructive tool is invoked in
 * an unattended context without an approved decision. Records a pending action
 * request first, so a checker can approve it (by the actionId on the error) and
 * the retry will proceed.
 *
 * Returns silently when the call is allowed (not gated, benign, or approved).
 */
export function assertMakerCheckerApproved(
	toolName: string,
	args: Record<string, unknown>,
	opts: EnforceOptions,
): void {
	if (!enforcementActive(opts.unattended)) return;

	const classified = classifyToolAction(toolName, args, opts.cwd);
	if (!classified) return;

	const store = getMakerCheckerStore();
	const rule = store.getRule(classified.action, classified.risk);
	if (!rule) return; // not gated by any rule

	// Already approved (and not yet consumed)? Let it through.
	if (findAndConsumeApproval(classified.action)) return;

	// Record the request so there is ALWAYS an audit row for a gated action.
	const { actionId } = store.submitAction(
		opts.makerId ?? "autonomous",
		classified.action,
		classified.action,
		args,
		classified.risk,
		AUTONOMY_RUNG.AUTONOMOUS,
	);
	if (actionId) actionIndex.set(actionId, classified.action);

	// AUTOMATIC-mode, NON-destructive rules (e.g. git push to a FEATURE branch) are
	// auto-approved: the autonomous engine opens PRs by design, so we gate them for
	// the AUDIT TRAIL without blocking the workflow. A DESTRUCTIVE risk ALWAYS blocks
	// even under an automatic rule (a dangerous shell command matches the automatic
	// `shell:*` rule but escalates to DESTRUCTIVE and must not slip through).
	// HUMAN-mode rules (rm / git push main / credentials / deploy / infinite) block.
	if (
		rule.checkerMode === "automatic" &&
		classified.risk !== ACTION_RISK.DESTRUCTIVE &&
		actionId
	) {
		store.approve(
			actionId,
			"auto-checker",
			"automatic",
			`auto-approved (${classified.risk}, reversible / branch-scoped)`,
		);
		consumed.add(actionId);
		return;
	}

	throw new MakerCheckerBlockedError(
		toolName,
		classified.action,
		classified.risk,
		actionId ?? "",
		`Destructive tool "${toolName}" (${classified.risk}) blocked in unattended context. ` +
			`No approved CheckerDecision (checker mode: ${rule.checkerMode}). Pending approval actionId=${actionId}.`,
	);
}
