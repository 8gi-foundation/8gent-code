/**
 * 8gent Code - Autonomy Ladder (issue #2699)
 *
 * The DECISION / AGENCY ladder, enforced as policy. It sits above the
 * capability ladder (which tools an officer holds) and answers a different
 * question: how much agency the system has over a decision *before James sees
 * it*. Five rungs, set per domain (inbound, social/outbound, code, spend),
 * never globally.
 *
 *   0 Observe          read / index / summarise privately; nothing leaves
 *   1 Surface          promote a few signals into the brief; awareness only
 *   2 Draft            produce a concrete proposal and HOLD it (requiresApproval)
 *   3 Act-with-approval checker PASS is a precondition; James is second signature
 *   4 Auto-within-budget reversible-only + budget-checked + checker-passed
 *
 * This module is ADDITIVE and deny-by-default. It NEVER enables autonomous
 * action: rung 2 holds, rung 3 needs a human, rung 4 needs reversible + a
 * distinct checker + a budget verdict the caller supplies. The default rung
 * when nothing is configured is 0 (Observe) - the most conservative.
 *
 * Companion specs:
 *   docs/isi/8GO-autonomy-governance-budget.md   (rung table + enforcement)
 *   docs/isi/8PO-autonomy-ladder-maker-checker.md (rung UX semantics)
 *   docs/isi/8SO-safety-gates-guardrails.md       (shadow scope + checker)
 *
 * Owner: 8GO (policy) / 8PO (semantics) / 8SO (safety floor).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SignedPayload, sign } from "./goal-state-hmac.js";

// ============================================
// Rungs
// ============================================

export enum Rung {
	Observe = 0,
	Surface = 1,
	Draft = 2,
	ActWithApproval = 3,
	AutoWithinBudget = 4,
}

/** Domains the ladder is set per. Rungs are NEVER set globally. */
export type AutonomyDomain = "inbound" | "social" | "code" | "spend";

/**
 * The most conservative rung is the default. If a domain has no configured
 * rung, the system observes only - it does not draft, queue, or act.
 */
export const DEFAULT_RUNG: Rung = Rung.Observe;

// ============================================
// Audit log (~/.8gent/audit.jsonl, append-only)
// ============================================

const DATA_DIR = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "audit.jsonl");

function ensureDataDir(): void {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

/**
 * One audit record per rung decision. Append-only - an edit is a new line,
 * never a mutation. No secret value ever enters the log (the maker/checker
 * identities are role ids, not payloads).
 */
export interface RungAuditRecord {
	ts: string;
	op: "rung";
	rung: Rung;
	domain: AutonomyDomain;
	channel?: string;
	action: string;
	/** "allow" | "require_approval" | "block" - the disposition we returned. */
	disposition: "allow" | "require_approval" | "block";
	maker?: string;
	checker?: string;
	verdict?: "PASS" | "FAIL";
	approver?: string;
	reversible?: boolean;
	reason: string;
}

/**
 * Append a rung decision to the audit trail. Best-effort: an audit write
 * failure must never break the policy flow (we still returned a decision),
 * but every rung-3/rung-4 decision SHOULD be logged before the side effect.
 */
export function appendRungAudit(record: Omit<RungAuditRecord, "ts" | "op">): void {
	const line: RungAuditRecord = {
		ts: new Date().toISOString(),
		op: "rung",
		...record,
	};
	try {
		ensureDataDir();
		fs.appendFileSync(AUDIT_LOG_FILE, `${JSON.stringify(line)}\n`);
	} catch (err) {
		console.warn(`[autonomy-ladder] audit write failed: ${err}`);
	}
}

/** Test/inspection helper. */
export function getAuditLogPath(): string {
	return AUDIT_LOG_FILE;
}

// ============================================
// Maker != checker
// ============================================

/**
 * The maker-checker context for a rung-3/rung-4 decision. The maker is the
 * doer that produced the proposal; the checker is a SEPARATE evaluation pass
 * whose verdict is a precondition. They MUST be distinct identities - a doer
 * can never sign off its own output.
 */
export interface MakerCheckerContext {
	/** Identity of the doer that produced the proposal. */
	maker?: string;
	/** Identity of the distinct checker pass. MUST differ from maker. */
	checker?: string;
	/** The checker's verdict. Reuses the SDD `review_passed` PASS|FAIL primitive. */
	verdict?: "PASS" | "FAIL";
	/** Human approver at rung 3; "system" at rung 4. */
	approver?: string;
	/**
	 * Whether the action is reversible (Undo token, git revert, retract,
	 * checkpoint exists). Irreversible actions cap at rung 3 and never auto.
	 */
	reversible?: boolean;
	/**
	 * Whether the action speaks to the world under James's name. Such actions
	 * cap at rung 3 in the first release regardless of the configured rung.
	 */
	underJamesName?: boolean;
}

/**
 * Is the maker distinct from the checker, with a PASS verdict? This is the
 * core maker != checker guarantee. Returns false if either identity is
 * missing, they are equal, or the verdict is not PASS.
 */
export function checkerPassed(ctx: MakerCheckerContext): boolean {
	if (!ctx.maker || !ctx.checker) return false;
	if (ctx.maker === ctx.checker) return false;
	return ctx.verdict === "PASS";
}

// ============================================
// Rung evaluation
// ============================================

export interface RungDecision {
	allowed: boolean;
	reason: string;
	requiresApproval?: boolean;
	/** The effective rung after irreversible/under-James's-name capping. */
	effectiveRung: Rung;
}

export interface RungEvalInput {
	domain: AutonomyDomain;
	/** The configured rung for this domain. Defaults to Observe if omitted. */
	rung?: Rung;
	action: string;
	channel?: string;
	maker?: MakerCheckerContext;
	/**
	 * Caller-supplied budget verdict (rung 4 only). The budget ENGINE lives
	 * elsewhere (ResourceGovernor / evaluateBudgetPolicy); the ladder only
	 * requires that the verdict is `true`. Absent verdict = treat as not
	 * within budget = cannot auto.
	 */
	budgetOk?: boolean;
}

/**
 * Evaluate the autonomy rung for an action. This is the enforcement point.
 *
 * Disposition by rung:
 *   0 Observe          -> allow (nothing leaves; the caller must not be on a
 *                         side-effecting path - that is gated separately by the
 *                         shadow/spawned scopes and the normal policy gates)
 *   1 Surface          -> allow (a brief line is not an action)
 *   2 Draft            -> requiresApproval (HOLD; nothing executes)
 *   3 Act-with-approval -> requiresApproval UNLESS checker passed AND a human
 *                          approver is present; even then it is the human's
 *                          tap that ships - this function never auto-fires it
 *   4 Auto-within-budget -> allow ONLY when reversible + checker passed
 *                          (maker != checker) + budgetOk; otherwise capped to
 *                          rung 3 behaviour (requiresApproval)
 *
 * Invariant: irreversible OR under-James's-name actions cap at rung 3 and
 * NEVER auto-fire, regardless of the configured rung.
 *
 * Every decision is written to ~/.8gent/audit.jsonl.
 */
export function evaluateRung(input: RungEvalInput): RungDecision {
	const configured = input.rung ?? DEFAULT_RUNG;
	const mc = input.maker ?? {};

	// Cap rule (8GO rule 2, 8PO "never auto", 8SO irreversible class):
	// irreversible or under-James's-name actions can never exceed rung 3.
	const irreversible = mc.reversible === false;
	const underName = mc.underJamesName === true;
	const ceiling = irreversible || underName ? Rung.ActWithApproval : Rung.AutoWithinBudget;
	const effectiveRung = Math.min(configured, ceiling) as Rung;

	const audit = (
		disposition: "allow" | "require_approval" | "block",
		reason: string,
	): RungDecision => {
		appendRungAudit({
			rung: effectiveRung,
			domain: input.domain,
			channel: input.channel,
			action: input.action,
			disposition,
			maker: mc.maker,
			checker: mc.checker,
			verdict: mc.verdict,
			approver: mc.approver,
			reversible: mc.reversible,
			reason,
		});
		return {
			allowed: disposition === "allow",
			reason,
			requiresApproval: disposition === "require_approval",
			effectiveRung,
		};
	};

	switch (effectiveRung) {
		case Rung.Observe:
			return audit("allow", "[rung-0-observe] read/index/summarise only; nothing leaves");

		case Rung.Surface:
			return audit("allow", "[rung-1-surface] awareness only; a brief line is not an action");

		case Rung.Draft:
			// Always holds. Nothing executes at rung 2.
			return audit(
				"require_approval",
				"[rung-2-draft] proposal held in the review queue; nothing executes until approved",
			);

		case Rung.ActWithApproval: {
			// Checker PASS is a precondition of being shown at all; even with a
			// pass, a human tap ships it - this function never auto-fires rung 3.
			if (!checkerPassed(mc)) {
				return audit(
					"require_approval",
					"[rung-3-maker-checker] checker has not passed (maker != checker + VERDICT:PASS required); holding for review",
				);
			}
			return audit(
				"require_approval",
				"[rung-3-maker-checker] checker passed; awaiting James's approval (human is the second signature)",
			);
		}

		case Rung.AutoWithinBudget: {
			// Rung 4 is the only rung that may auto. It requires ALL of:
			//   reversible-only, maker != checker + PASS, and a budget verdict.
			if (mc.reversible !== true) {
				return audit(
					"require_approval",
					"[rung-4-auto] not marked reversible; irreversible actions cap at rung 3 and never auto",
				);
			}
			if (!checkerPassed(mc)) {
				return audit(
					"require_approval",
					"[rung-4-auto] checker has not passed (maker != checker + VERDICT:PASS required); cannot auto",
				);
			}
			if (input.budgetOk !== true) {
				return audit(
					"require_approval",
					"[rung-4-auto] budget verdict absent or over-cap; cannot auto until inside the envelope",
				);
			}
			return audit(
				"allow",
				"[rung-4-auto] reversible + checker-passed + within budget; machine is the second signature, James audits after via receipt",
			);
		}

		default:
			// Defensive: an unknown rung is denied, not allowed.
			return audit("block", `[rung-unknown] unrecognised rung ${effectiveRung}; denied`);
	}
}

// ============================================
// Signed approval grant (rung 3/4 chain of custody)
// ============================================

export interface ApprovalGrantPayload {
	action: string;
	domain: AutonomyDomain;
	channel?: string;
	maker: string;
	checker: string;
	verdict: "PASS" | "FAIL";
	/** Human name at rung 3; "system" at rung 4. */
	approver: string;
	reversible: boolean;
	ts: string;
	nonce: string;
}

/**
 * Produce an HMAC-signed approval grant over the goal/maker-checker state.
 * Re-uses the goal-state HMAC mechanism so an approval cannot be forged or
 * back-dated between sessions. An autonomous agent cannot mint this because
 * it does not approve itself - the maker is never the approver, and a
 * maker == checker grant is rejected here as well.
 *
 * Throws if maker == checker (the maker != checker guarantee) or if the
 * verdict is not PASS - an unsigned/invalid grant is treated as no-approval.
 */
export function signApprovalGrant(
	payload: Omit<ApprovalGrantPayload, "ts" | "nonce">,
	keyOverride?: Buffer,
): SignedPayload<ApprovalGrantPayload> {
	if (!payload.maker || !payload.checker || payload.maker === payload.checker) {
		throw new Error(
			"[autonomy-ladder] approval grant rejected: maker must differ from checker (maker != checker)",
		);
	}
	if (payload.verdict !== "PASS") {
		throw new Error("[autonomy-ladder] approval grant rejected: checker verdict must be PASS");
	}
	if (payload.maker === payload.approver) {
		throw new Error("[autonomy-ladder] approval grant rejected: maker cannot be its own approver");
	}
	const full: ApprovalGrantPayload = {
		...payload,
		ts: new Date().toISOString(),
		nonce: crypto.randomBytes(16).toString("hex"),
	};
	return sign(full, keyOverride);
}
