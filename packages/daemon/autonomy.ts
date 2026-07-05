/**
 * Vessel Autonomy Ladder
 *
 * Graduated trust model for vessel actions.
 * Each rung represents a level of trust, with corresponding
 * capability requirements and escalation paths.
 *
 * Rung 0: OBSERVE  - read-only, no writes, no execution
 * Rung 1: SUGGEST  - can read and propose, no execution
 * Rung 2: ASSIST   - can read, write, dispatch (requires confirmation)
 * Rung 3: DELEGATE - can execute within guardrails
 * Rung 4: AUTONOMOUS - full trust, all capabilities
 */

/**
 * Autonomy-ladder capabilities. This is the ladder's own escalating capability
 * vocabulary and is distinct from the dispatch-protocol `DispatchCapability`
 * set (read/write_basic/write_full/admin) in ./types.ts.
 */
export type RungCapability =
	| "read"
	| "suggest"
	| "write"
	| "dispatch"
	| "execute"
	| "escalate";

/** Autonomy rung levels, higher = more trust */
export const AUTONOMY_RUNG = {
	OBSERVE: 0,
	SUGGEST: 1,
	ASSIST: 2,
	DELEGATE: 3,
	AUTONOMOUS: 4,
} as const;

export type AutonomyRung = (typeof AUTONOMY_RUNG)[keyof typeof AUTONOMY_RUNG];

/** Human-readable rung labels */
export const AUTONOMY_RUNG_LABEL: Record<AutonomyRung, string> = {
	[AUTONOMY_RUNG.OBSERVE]: "Observe",
	[AUTONOMY_RUNG.SUGGEST]: "Suggest",
	[AUTONOMY_RUNG.ASSIST]: "Assist",
	[AUTONOMY_RUNG.DELEGATE]: "Delegate",
	[AUTONOMY_RUNG.AUTONOMOUS]: "Autonomous",
};

/** Capabilities required for each rung */
export const RUNG_REQUIREMENTS: Record<AutonomyRung, RungCapability[]> = {
	[AUTONOMY_RUNG.OBSERVE]: ["read"],
	[AUTONOMY_RUNG.SUGGEST]: ["read", "suggest"],
	[AUTONOMY_RUNG.ASSIST]: ["read", "write", "dispatch"],
	[AUTONOMY_RUNG.DELEGATE]: ["read", "write", "dispatch", "execute"],
	[AUTONOMY_RUNG.AUTONOMOUS]: ["read", "write", "dispatch", "execute", "escalate"],
};

/** Rung descriptions */
export const RUNG_DESCRIPTIONS: Record<AutonomyRung, string> = {
	[AUTONOMY_RUNG.OBSERVE]:
		"Can read state and events. Cannot write, execute, or dispatch messages.",
	[AUTONOMY_RUNG.SUGGEST]:
		"Can read and propose actions. Proposes are advisory; human must approve.",
	[AUTONOMY_RUNG.ASSIST]:
		"Can read, write, and dispatch. Executes within confirmation guardrails.",
	[AUTONOMY_RUNG.DELEGATE]:
		"Can execute autonomously within defined guardrails. Escalates on boundary violations.",
	[AUTONOMY_RUNG.AUTONOMOUS]:
		"Full trust. All capabilities enabled. Reserved for verified, trusted surfaces.",
};

/** Action risk classification */
export const ACTION_RISK = {
	SAFE: "safe",
	BOUNDED: "bounded",
	RISKY: "risky",
	DESTRUCTIVE: "destructive",
} as const;

export type ActionRisk = (typeof ACTION_RISK)[keyof typeof ACTION_RISK];

/** Risk thresholds by rung (maximum risk level allowed) */
export const RUNG_RISK_THRESHOLDS: Record<AutonomyRung, ActionRisk> = {
	[AUTONOMY_RUNG.OBSERVE]: ACTION_RISK.SAFE,
	[AUTONOMY_RUNG.SUGGEST]: ACTION_RISK.SAFE,
	[AUTONOMY_RUNG.ASSIST]: ACTION_RISK.BOUNDED,
	[AUTONOMY_RUNG.DELEGATE]: ACTION_RISK.RISKY,
	[AUTONOMY_RUNG.AUTONOMOUS]: ACTION_RISK.DESTRUCTIVE,
};

/** Check if a capability set meets rung requirements */
export function meetsRungRequirements(
	capabilities: RungCapability[],
	requirements: RungCapability[],
): boolean {
	return requirements.every((req) => capabilities.includes(req));
}

/** Get the minimum rung for a capability set */
export function rungForCapabilities(
	capabilities: RungCapability[],
): AutonomyRung {
	// Check from highest to lowest
	for (let rung = AUTONOMY_RUNG.AUTONOMOUS; rung >= 0; rung--) {
		if (meetsRungRequirements(capabilities, RUNG_REQUIREMENTS[rung])) {
			return rung;
		}
	}
	return AUTONOMY_RUNG.OBSERVE;
}

/** Check if an action is permitted at a given rung */
export function isActionPermitted(
	rung: AutonomyRung,
	risk: ActionRisk,
): boolean {
	const threshold = RUNG_RISK_THRESHOLDS[rung];
	const riskOrder = [ACTION_RISK.SAFE, ACTION_RISK.BOUNDED, ACTION_RISK.RISKY, ACTION_RISK.DESTRUCTIVE];
	return riskOrder.indexOf(risk) <= riskOrder.indexOf(threshold);
}

/** Escalation urgency levels */
export const ESCALATION_URGENCY = {
	LOW: "low",
	MEDIUM: "medium",
	HIGH: "high",
	CRITICAL: "critical",
} as const;

export type EscalationUrgency = (typeof ESCALATION_URGENCY)[keyof typeof ESCALATION_URGENCY];

/** Escalation entry */
export interface EscalationEntry {
	id: string;
	timestamp: number;
	fromRung: AutonomyRung;
	toRung: AutonomyRung;
	reason: string;
	urgency: EscalationUrgency;
	status: "pending" | "approved" | "rejected" | "expired";
}

/** Autonomy policy for a surface */
export interface AutonomyPolicy {
	surfaceId: string;
	userId: string;
	baseRung: AutonomyRung;
	grants: AutonomyRung[];
	restrictions: AutonomyRung[];
	maxRung: AutonomyRung;
}

/** Effective rung calculation */
export function effectiveRung(policy: AutonomyPolicy): AutonomyRung {
	// Start with base rung
	let rung = policy.baseRung;

	// Apply grants (can only increase)
	for (const grant of policy.grants) {
		if (grant > rung) rung = grant;
	}

	// Apply restrictions (can only decrease)
	for (const restriction of policy.restrictions) {
		if (restriction < rung) rung = restriction;
	}

	// Cap at max
	if (rung > policy.maxRung) rung = policy.maxRung;

	return rung;
}

/** Autonomy policy store */
export class AutonomyPolicyStore {
	private policies = new Map<string, AutonomyPolicy>();
	private escalations: EscalationEntry[] = [];

	/** Get policy for a surface */
	get(surfaceId: string): AutonomyPolicy | undefined {
		return this.policies.get(surfaceId);
	}

	/** Set policy for a surface */
	set(policy: AutonomyPolicy): void {
		this.policies.set(policy.surfaceId, policy);
	}

	/** Remove policy for a surface */
	remove(surfaceId: string): void {
		this.policies.delete(surfaceId);
	}

	/** List all policies for a user */
	byUser(userId: string): AutonomyPolicy[] {
		return Array.from(this.policies.values()).filter((p) => p.userId === userId);
	}

	/** Create escalation request */
	escalate(
		surfaceId: string,
		toRung: AutonomyRung,
		reason: string,
		urgency: EscalationUrgency = "medium",
	): EscalationEntry {
		const policy = this.policies.get(surfaceId);
		const fromRung = policy ? effectiveRung(policy) : AUTONOMY_RUNG.OBSERVE;

		const entry: EscalationEntry = {
			id: `esc|${surfaceId}|${Date.now()}`,
			timestamp: Date.now(),
			fromRung,
			toRung,
			reason,
			urgency,
			status: "pending",
		};

		this.escalations.push(entry);
		return entry;
	}

	/** Approve escalation */
	approve(escalationId: string): boolean {
		const entry = this.escalations.find((e) => e.id === escalationId);
		if (!entry || entry.status !== "pending") return false;

		entry.status = "approved";

		// ID format: esc|{surfaceId}|{timestamp}
		const parts = entry.id.split("|");
		const surfaceId = parts[1];
		const policy = this.policies.get(surfaceId);
		if (policy) {
			policy.grants.push(entry.toRung);
		}

		return true;
	}

	/** Reject escalation */
	reject(escalationId: string): boolean {
		const entry = this.escalations.find((e) => e.id === escalationId);
		if (!entry || entry.status !== "pending") return false;
		entry.status = "rejected";
		return true;
	}

	/** Get pending escalations */
	pending(): EscalationEntry[] {
		return this.escalations.filter((e) => e.status === "pending");
	}

	/** Get escalations for a surface */
	escalationsFor(surfaceId: string): EscalationEntry[] {
		return this.escalations.filter((e) => e.id.startsWith(surfaceId.split("_")[0]));
	}

	/** Clear all data */
	clear(): void {
		this.policies.clear();
		this.escalations = [];
	}
}

/** Convenience: create a default policy */
export function createDefaultPolicy(
	surfaceId: string,
	userId: string,
	rung: AutonomyRung = AUTONOMY_RUNG.ASSIST,
): AutonomyPolicy {
	return {
		surfaceId,
		userId,
		baseRung: rung,
		grants: [],
		restrictions: [],
		maxRung: rung,
	};
}

/** Autonomy audit log entry */
export interface AutonomyAuditEntry {
	timestamp: number;
	surfaceId: string;
	action: string;
	rung: AutonomyRung;
	risk: ActionRisk;
	permitted: boolean;
	escalated: boolean;
}

/** Autonomy audit log */
export class AutonomyAuditLog {
	private entries: AutonomyAuditEntry[] = [];
	private maxEntries = 10000;

	/** Log an action decision */
	log(entry: Omit<AutonomyAuditEntry, "timestamp">): void {
		this.entries.push({ ...entry, timestamp: Date.now() });
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
	}

	/** Query logs by surface */
	forSurface(surfaceId: string, limit = 100): AutonomyAuditEntry[] {
		return this.entries
			.filter((e) => e.surfaceId === surfaceId)
			.slice(-limit);
	}

	/** Query logs by risk level */
	forRisk(risk: ActionRisk, limit = 100): AutonomyAuditEntry[] {
		return this.entries
			.filter((e) => e.risk === risk)
			.slice(-limit);
	}

	/** Get denied actions */
	denied(limit = 100): AutonomyAuditEntry[] {
		return this.entries
			.filter((e) => !e.permitted)
			.slice(-limit);
	}

	/** Get escalated actions */
	escalated(limit = 100): AutonomyAuditEntry[] {
		return this.entries
			.filter((e) => e.escalated)
			.slice(-limit);
	}

	/** Clear old entries */
	clear(olderThan?: number): void {
		if (olderThan) {
			this.entries = this.entries.filter((e) => e.timestamp > olderThan);
		} else {
			this.entries = [];
		}
	}
}
