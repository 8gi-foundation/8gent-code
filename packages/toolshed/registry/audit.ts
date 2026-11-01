/**
 * 8gent Toolshed - Capability Audit Log
 *
 * Records every tool invocation that is blocked by the capability gate.
 * The log is in-memory by default so unit tests stay deterministic; in
 * production, the daemon's audit sink subscribes via {@link onAuditEntry}
 * and persists to disk / Convex.
 *
 * Why an audit log: blocked invocations are signal, not noise. They tell
 * us when an agent is reaching beyond its grant — a leading indicator
 * for both bugs and policy escalations.
 */

import type { ToolCapabilityTier } from "../../types";

export interface CapabilityAuditEntry {
	timestamp: string;
	sessionId: string;
	tool: string;
	required: ToolCapabilityTier[];
	missing: ToolCapabilityTier[];
	granted: ToolCapabilityTier[];
	reason: string;
}

const log: CapabilityAuditEntry[] = [];
type Listener = (entry: CapabilityAuditEntry) => void;
const listeners = new Set<Listener>();

const MAX_IN_MEMORY = 1000;

export function recordCapabilityDenial(entry: Omit<CapabilityAuditEntry, "timestamp">): void {
	const full: CapabilityAuditEntry = {
		...entry,
		timestamp: new Date().toISOString(),
	};
	log.push(full);
	if (log.length > MAX_IN_MEMORY) log.shift();
	for (const fn of listeners) {
		try {
			fn(full);
		} catch {
			// Listener errors must never crash the executor.
		}
	}
}

export function getCapabilityAuditLog(): readonly CapabilityAuditEntry[] {
	return log;
}

export function clearCapabilityAuditLog(): void {
	log.length = 0;
}

export function onAuditEntry(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}
