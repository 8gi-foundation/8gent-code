/**
 * Maker-Checker Pattern for High-Risk Actions
 *
 * Implements the two-person rule for sensitive operations.
 * Actions above a risk threshold require a second agent or human
 * to approve before execution.
 */

import { AUTONOMY_RUNG, ACTION_RISK, type AutonomyRung, type ActionRisk } from "./autonomy";

// ============================================
// Types
// ============================================

export const CHECKER_MODE = {
	AUTOMATIC: "automatic", // AI checker (requires sufficient autonomy rung)
	HUMAN: "human", // Requires human approval
	DISABLED: "disabled", // No checker required
} as const;

export type CheckerMode = (typeof CHECKER_MODE)[keyof typeof CHECKER_MODE];

export const ACTION_STATUS = {
	PENDING: "pending",
	APPROVED: "approved",
	REJECTED: "rejected",
	EXPIRED: "expired",
	CANCELLED: "cancelled",
} as const;

export type ActionStatus = (typeof ACTION_STATUS)[keyof typeof ACTION_STATUS];

// ============================================
// Action Request
// ============================================

export interface MakerAction {
	actionId: string;
	makerId: string; // Vessel or agent making the request
	action: string; // Human-readable action description
	target: string; // What the action targets
	parameters: Record<string, unknown>;
	risk: ActionRisk;
	rung: AutonomyRung;
	timestamp: number;
	expiresAt: number;
}

export interface CheckerDecision {
	decisionId: string;
	actionId: string;
	checkerId: string; // Checker who made the decision
	mode: CheckerMode; // How the decision was made
	status: ActionStatus;
	reason: string;
	timestamp: number;
}

// ============================================
// Risk-Based Rules
// ============================================

export interface MakerCheckerRule {
	/** Actions matching this pattern (glob-style) */
	actionPattern: string;
	/** Minimum risk level that triggers this rule */
	minRisk: ActionRisk;
	/** Required checker mode */
	checkerMode: CheckerMode;
	/** Required autonomy rung for automatic checking */
	requiredRung: AutonomyRung;
	/** Time limit for approval (ms) */
	timeoutMs: number;
	/** Whether to notify owner */
	notifyOwner: boolean;
}

// Default rules based on risk levels
export const DEFAULT_RULES: MakerCheckerRule[] = [
	{
		actionPattern: "git:push:*",
		minRisk: "RISKY",
		checkerMode: "automatic",
		requiredRung: AUTONOMY_RUNG.AUTONOMOUS,
		timeoutMs: 5 * 60 * 1000,
		notifyOwner: true,
	},
	{
		actionPattern: "file:delete:*",
		minRisk: "RISKY",
		checkerMode: "human",
		requiredRung: AUTONOMY_RUNG.DELEGATE,
		timeoutMs: 10 * 60 * 1000,
		notifyOwner: true,
	},
	{
		actionPattern: "shell:*",
		minRisk: "BOUNDED",
		checkerMode: "automatic",
		requiredRung: AUTONOMY_RUNG.ASSIST,
		timeoutMs: 2 * 60 * 1000,
		notifyOwner: false,
	},
	{
		actionPattern: "git:push:main",
		minRisk: "DESTRUCTIVE",
		checkerMode: "human",
		requiredRung: AUTONOMY_RUNG.AUTONOMOUS,
		timeoutMs: 30 * 60 * 1000,
		notifyOwner: true,
	},
	{
		actionPattern: "credential:*",
		minRisk: "DESTRUCTIVE",
		checkerMode: "human",
		requiredRung: AUTONOMY_RUNG.AUTONOMOUS,
		timeoutMs: 60 * 60 * 1000,
		notifyOwner: true,
	},
];

// ============================================
// Maker-Checker Store
// ============================================

export class MakerCheckerStore {
	private pendingActions = new Map<string, MakerAction>();
	private decisions = new Map<string, CheckerDecision>();
	private rules: MakerCheckerRule[] = [...DEFAULT_RULES];
	private actionCounter = 0;

	/** Add a rule */
	addRule(rule: MakerCheckerRule): void {
		this.rules.push(rule);
	}

	/** Remove a rule */
	removeRule(actionPattern: string): void {
		this.rules = this.rules.filter((r) => r.actionPattern !== actionPattern);
	}

	/** Get applicable rule for an action */
	getRule(action: string, risk: ActionRisk): MakerCheckerRule | null {
		// Find matching rule with highest specificity
		const matchingRules = this.rules
			.filter((r) => this.matchPattern(action, r.actionPattern))
			.filter((r) => this.riskMeetsThreshold(risk, r.minRisk))
			.sort((a, b) => {
				// Primary: more specific patterns (more segments) win
				const specDiff = b.actionPattern.split(":").length - a.actionPattern.split(":").length;
				if (specDiff !== 0) return specDiff;
				// Tiebreaker: exact match (no wildcards) beats wildcard pattern
				const aIsWildcard = a.actionPattern.includes("*");
				const bIsWildcard = b.actionPattern.includes("*");
				if (aIsWildcard !== bIsWildcard) return aIsWildcard ? 1 : -1;
				return 0;
			});

		return matchingRules[0] || null;
	}

	/** Check if action requires a checker */
	requiresChecker(action: string, risk: ActionRisk): boolean {
		return this.getRule(action, risk) !== null;
	}

	/** Submit an action for checking */
	submitAction(
		makerId: string,
		action: string,
		target: string,
		parameters: Record<string, unknown>,
		risk: ActionRisk,
		rung: AutonomyRung,
	): { requiresChecker: boolean; actionId: string | null; rule: MakerCheckerRule | null } {
		const rule = this.getRule(action, risk);

		if (!rule) {
			return { requiresChecker: false, actionId: null, rule: null };
		}

		const actionId = `act_${Date.now()}_${++this.actionCounter}`;
		const now = Date.now();

		const makerAction: MakerAction = {
			actionId,
			makerId,
			action,
			target,
			parameters,
			risk,
			rung,
			timestamp: now,
			expiresAt: now + rule.timeoutMs,
		};

		this.pendingActions.set(actionId, makerAction);

		return { requiresChecker: true, actionId, rule };
	}

	/** Approve an action */
	approve(
		actionId: string,
		checkerId: string,
		mode: CheckerMode,
		reason: string = "Approved",
	): boolean {
		const action = this.pendingActions.get(actionId);
		if (!action) return false;

		if (Date.now() > action.expiresAt) {
			this.expireAction(actionId);
			return false;
		}

		const decision: CheckerDecision = {
			decisionId: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			actionId,
			checkerId,
			mode,
			status: ACTION_STATUS.APPROVED,
			reason,
			timestamp: Date.now(),
		};

		this.decisions.set(actionId, decision);
		this.pendingActions.delete(actionId);

		return true;
	}

	/** Reject an action */
	reject(
		actionId: string,
		checkerId: string,
		mode: CheckerMode,
		reason: string,
	): boolean {
		const action = this.pendingActions.get(actionId);
		if (!action) return false;

		const decision: CheckerDecision = {
			decisionId: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			actionId,
			checkerId,
			mode,
			status: ACTION_STATUS.REJECTED,
			reason,
			timestamp: Date.now(),
		};

		this.decisions.set(actionId, decision);
		this.pendingActions.delete(actionId);

		return true;
	}

	/** Cancel a pending action */
	cancel(actionId: string): boolean {
		const action = this.pendingActions.get(actionId);
		if (!action) return false;

		this.pendingActions.delete(actionId);
		return true;
	}

	/** Get pending actions for a maker */
	pendingForMaker(makerId: string): MakerAction[] {
		return Array.from(this.pendingActions.values()).filter(
			(a) => a.makerId === makerId,
		);
	}

	/** Get decision for an action */
	getDecision(actionId: string): CheckerDecision | undefined {
		return this.decisions.get(actionId);
	}

	/** Get all pending actions */
	getPending(): MakerAction[] {
		return Array.from(this.pendingActions.values());
	}

	/** Expire stale actions */
	private expireAction(actionId: string): void {
		const action = this.pendingActions.get(actionId);
		if (!action) return;

		const decision: CheckerDecision = {
			decisionId: `dec_${Date.now()}_expired`,
			actionId,
			checkerId: "system",
			mode: CHECKER_MODE.AUTOMATIC,
			status: ACTION_STATUS.EXPIRED,
			reason: "Action expired before decision",
			timestamp: Date.now(),
		};

		this.decisions.set(actionId, decision);
		this.pendingActions.delete(actionId);
	}

	/** Check and expire stale actions */
	cleanup(): number {
		const now = Date.now();
		let count = 0;

		for (const [actionId, action] of this.pendingActions) {
			if (now > action.expiresAt) {
				this.expireAction(actionId);
				count++;
			}
		}

		return count;
	}

	/** Clear all data */
	clear(): void {
		this.pendingActions.clear();
		this.decisions.clear();
	}

	// ============================================
	// Private helpers
	// ============================================

	private matchPattern(action: string, pattern: string): boolean {
		const actionParts = action.split(":");
		const patternParts = pattern.split(":");

		for (let i = 0; i < patternParts.length; i++) {
			if (patternParts[i] === "*") continue;
			if (patternParts[i] !== actionParts[i]) return false;
		}

		return true;
	}

	private riskMeetsThreshold(actionRisk: ActionRisk, minRisk: ActionRisk): boolean {
		const riskOrder: ActionRisk[] = ["SAFE", "BOUNDED", "RISKY", "DESTRUCTIVE"];
		return riskOrder.indexOf(actionRisk) >= riskOrder.indexOf(minRisk);
	}
}

// ============================================
// Automatic Checker (AI-powered)
// ============================================

export interface AutomaticCheckerConfig {
	/** Minimum rung to be an automatic checker */
	minRung: AutonomyRung;
	/** Risk levels to auto-approve */
	autoApproveRisks: ActionRisk[];
	/** Risk levels to auto-reject */
	autoRejectRisks: ActionRisk[];
}

export const DEFAULT_CHECKER_CONFIG: AutomaticCheckerConfig = {
	minRung: AUTONOMY_RUNG.DELEGATE,
	autoApproveRisks: ["SAFE", "BOUNDED"],
	autoRejectRisks: ["DESTRUCTIVE"],
};

export class AutomaticChecker {
	private config: AutomaticCheckerConfig;

	constructor(config: Partial<AutomaticCheckerConfig> = {}) {
		this.config = { ...DEFAULT_CHECKER_CONFIG, ...config };
	}

	/** Check if this checker can operate at given rung */
	canCheck(rung: AutonomyRung): boolean {
		return rung >= this.config.minRung;
	}

	/** Make automatic decision on an action */
	decide(action: MakerAction): { decision: ActionStatus; reason: string } {
		// Auto-approve safe actions
		if (this.config.autoApproveRisks.includes(action.risk)) {
			return {
				decision: ACTION_STATUS.APPROVED,
				reason: `Auto-approved ${action.risk} action`,
			};
		}

		// Auto-reject destructive actions
		if (this.config.autoRejectRisks.includes(action.risk)) {
			return {
				decision: ACTION_STATUS.REJECTED,
				reason: `Auto-rejected ${action.risk} action - requires human approval`,
			};
		}

		// For bounded/risky, escalate to human
		return {
			decision: ACTION_STATUS.PENDING,
			reason: `${action.risk} action requires human approval`,
		};
	}
}