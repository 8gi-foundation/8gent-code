/**
 * @8gent/eight-bdh - G8WAY audit-trace persistence and authority validation.
 *
 * Owner: 8GO (Solomon). Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md §7.2.
 *
 * Two responsibilities:
 *   1. validateForAuthority(): reject traces that fail the constitutional
 *      precondition for the requested authority level. L3+ requires a
 *      non-trivial trace; L5 is reserved for the boardroom and never an
 *      orchestrator decision.
 *   2. persistAuditTrace(): append one JSONL line to the G8WAY log. This is
 *      the chain-of-custody artifact for every routing decision.
 *
 * Path resolution:
 *   - process.env.BDH_AUDIT_PATH if set
 *   - else ~/.8gent/g8way/audit-traces.jsonl
 * Parent directories are created on first write.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuditTrace } from "./types";

export type AuthorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface AuditMeta {
	decisionId: string;
	authorityLevel: AuthorityLevel;
	modelId: string;
}

export type ValidationResult =
	| { ok: true }
	| { ok: false; reason: string };

/**
 * Thrown by auditedDecisionEnvelope() when validation fails. Callers in
 * packages/g8way/ should catch this and surface a denial event rather than
 * silently dropping the decision.
 */
export class G8wayDenialError extends Error {
	readonly decisionId: string;
	readonly authorityLevel: AuthorityLevel;
	readonly reason: string;

	constructor(meta: AuditMeta, reason: string) {
		super(
			`G8WAY denial: decisionId=${meta.decisionId} authority=${meta.authorityLevel} reason=${reason}`,
		);
		this.name = "G8wayDenialError";
		this.decisionId = meta.decisionId;
		this.authorityLevel = meta.authorityLevel;
		this.reason = reason;
	}
}

function resolveAuditPath(): string {
	const fromEnv = process.env.BDH_AUDIT_PATH;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".8gent", "g8way", "audit-traces.jsonl");
}

function isNonEmptyTrace(trace: AuditTrace): boolean {
	if (!trace) return false;
	const hasSyn = Array.isArray(trace.synapseIds) && trace.synapseIds.length > 0;
	const hasTop =
		Array.isArray(trace.topActivations) && trace.topActivations.length > 0;
	const hasReason =
		Array.isArray(trace.reasoningChain) && trace.reasoningChain.length > 0;
	return hasSyn || hasTop || hasReason;
}

/**
 * Constitutional gate per spec §7.2. Pure function, no I/O.
 *
 *   L0..L2 -> any non-empty trace passes.
 *   L3..L4 -> requires synapseIds.length >= 2 AND topActivations.length >= 1.
 *   L5     -> always fails: "L5 reserved for boardroom" (orchestrator must
 *             not decide constitutional changes).
 */
export function validateForAuthority(
	trace: AuditTrace,
	level: AuthorityLevel,
): ValidationResult {
	if (level === 5) {
		return { ok: false, reason: "L5 reserved for boardroom" };
	}

	if (level >= 3) {
		const synOk = Array.isArray(trace.synapseIds) && trace.synapseIds.length >= 2;
		const topOk =
			Array.isArray(trace.topActivations) && trace.topActivations.length >= 1;
		if (!synOk) {
			return {
				ok: false,
				reason: `L${level} requires synapseIds.length >= 2 (got ${trace?.synapseIds?.length ?? 0})`,
			};
		}
		if (!topOk) {
			return {
				ok: false,
				reason: `L${level} requires topActivations.length >= 1 (got ${trace?.topActivations?.length ?? 0})`,
			};
		}
		return { ok: true };
	}

	// L0..L2
	if (!isNonEmptyTrace(trace)) {
		return {
			ok: false,
			reason: `L${level} requires a non-empty trace (synapseIds, topActivations, or reasoningChain)`,
		};
	}
	return { ok: true };
}

interface PersistedRecord {
	v: 1;
	ts: string;
	decisionId: string;
	authorityLevel: AuthorityLevel;
	modelId: string;
	trace: AuditTrace;
}

/**
 * Append one JSONL line to the G8WAY audit log. Creates parent dirs on first
 * write. Caller is responsible for having validated the trace if the action
 * authority requires it - this function does not enforce policy.
 */
export async function persistAuditTrace(
	trace: AuditTrace,
	meta: AuditMeta,
): Promise<void> {
	const path = resolveAuditPath();
	await mkdir(dirname(path), { recursive: true });

	const record: PersistedRecord = {
		v: 1,
		ts: new Date().toISOString(),
		decisionId: meta.decisionId,
		authorityLevel: meta.authorityLevel,
		modelId: meta.modelId,
		trace,
	};

	const line = `${JSON.stringify(record)}\n`;
	await appendFile(path, line, { encoding: "utf8" });
}

/**
 * Convenience for callers in packages/g8way/ and packages/orchestration/:
 *   1. validateForAuthority()
 *   2. on pass -> persistAuditTrace(), return { ok, path-resolution-implicit }
 *   3. on fail -> throw G8wayDenialError (no persistence)
 *
 * The throw-on-fail path is intentional: a denied decision is not part of the
 * normal audit log. Denial events are logged separately by g8way/events.
 */
export async function auditedDecisionEnvelope(
	trace: AuditTrace,
	meta: AuditMeta,
): Promise<{ ok: true }> {
	const validation = validateForAuthority(trace, meta.authorityLevel);
	if (!validation.ok) {
		throw new G8wayDenialError(meta, validation.reason);
	}
	await persistAuditTrace(trace, meta);
	return { ok: true };
}
