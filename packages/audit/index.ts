/**
 * @8gent/audit - Access audit log for child records.
 *
 * Detective control required by the 8gentjr DPIA (G7 split): on every read
 * of a child-associated record, call logAccess(). Query with queryAccess()
 * from an admin surface.
 *
 * Scope: reads of child-associated records (profile, vocabulary, transcripts)
 * plus derivations and exports. Do NOT log every cache hit or internal call.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CapabilityAuditStore } from "./capability-store.js";
import { DecisionAuditStore, GENESIS_HASH } from "./decision-store.js";
import { AccessAuditStore } from "./store.js";
import type {
	AccessEvent,
	AccessOperation,
	ActorKind,
	CapabilityEvent,
	CapabilityOperation,
	ChainVerification,
	DecisionEvent,
	DecisionGate,
	DecisionOutcome,
	DecisionRequestKind,
	LogAccessInput,
	LogCapabilityInput,
	LogDecisionInput,
	QueryAccessOptions,
	QueryCapabilityOptions,
	QueryDecisionOptions,
} from "./types.js";

export { AccessAuditStore, CapabilityAuditStore, DecisionAuditStore, GENESIS_HASH };
export type {
	AccessEvent,
	AccessOperation,
	ActorKind,
	CapabilityEvent,
	CapabilityOperation,
	ChainVerification,
	DecisionEvent,
	DecisionGate,
	DecisionOutcome,
	DecisionRequestKind,
	LogAccessInput,
	LogCapabilityInput,
	LogDecisionInput,
	QueryAccessOptions,
	QueryCapabilityOptions,
	QueryDecisionOptions,
};

let _shared: AccessAuditStore | null = null;
let _sharedPath: string | null = null;
let _sharedCap: CapabilityAuditStore | null = null;
let _sharedCapPath: string | null = null;

function resolveAuditDir(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	const dir = path.join(base, "audit");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function resolveDefaultPath(): string {
	return path.join(resolveAuditDir(), "access.db");
}

function resolveDefaultCapabilityPath(): string {
	return path.join(resolveAuditDir(), "capability.db");
}

function resolveDefaultDecisionPath(): string {
	return path.join(resolveAuditDir(), "decisions.db");
}

/** Get the shared audit store. Opens it on first call. */
export function getAccessAuditStore(dbPath?: string): AccessAuditStore {
	const target = dbPath ?? _sharedPath ?? resolveDefaultPath();
	if (_shared && _sharedPath === target) return _shared;
	if (_shared) _shared.close();
	_shared = new AccessAuditStore(target);
	_sharedPath = target;
	return _shared;
}

/** Reset the shared store. Primarily for tests. */
export function resetAccessAuditStore(): void {
	if (_shared) _shared.close();
	_shared = null;
	_sharedPath = null;
}

/** Convenience wrapper. Writes a single event to the shared store. */
export function logAccess(input: LogAccessInput): string {
	return getAccessAuditStore().logAccess(input);
}

/** Query the shared store. Read-only. */
export function queryAccess(options: QueryAccessOptions = {}): AccessEvent[] {
	return getAccessAuditStore().queryAccess(options);
}

/** Get the shared capability audit store. Opens it on first call. */
export function getCapabilityAuditStore(dbPath?: string): CapabilityAuditStore {
	const target = dbPath ?? _sharedCapPath ?? resolveDefaultCapabilityPath();
	if (_sharedCap && _sharedCapPath === target) return _sharedCap;
	if (_sharedCap) _sharedCap.close();
	_sharedCap = new CapabilityAuditStore(target);
	_sharedCapPath = target;
	return _sharedCap;
}

/** Reset the shared capability store. Primarily for tests. */
export function resetCapabilityAuditStore(): void {
	if (_sharedCap) _sharedCap.close();
	_sharedCap = null;
	_sharedCapPath = null;
}

/** Convenience wrapper. Writes a single capability grant/revoke event. */
export function logCapability(input: LogCapabilityInput): string {
	return getCapabilityAuditStore().logCapability(input);
}

/** Query the shared capability log. Read-only. */
export function queryCapability(options: QueryCapabilityOptions = {}): CapabilityEvent[] {
	return getCapabilityAuditStore().queryCapability(options);
}

// ============================================
// Tool-call decision chain (issue #2756 step 3)
// ============================================

let _sharedDec: DecisionAuditStore | null = null;
let _sharedDecPath: string | null = null;

/** Get the shared tamper-evident decision store. Opens it on first call. */
export function getDecisionAuditStore(dbPath?: string): DecisionAuditStore {
	const target = dbPath ?? _sharedDecPath ?? resolveDefaultDecisionPath();
	if (_sharedDec && _sharedDecPath === target) return _sharedDec;
	if (_sharedDec) _sharedDec.close();
	_sharedDec = new DecisionAuditStore(target);
	_sharedDecPath = target;
	return _sharedDec;
}

/** Reset the shared decision store. Primarily for tests. */
export function resetDecisionAuditStore(): void {
	if (_sharedDec) _sharedDec.close();
	_sharedDec = null;
	_sharedDecPath = null;
}

/**
 * Append one tool-call decision to the shared hash chain.
 * Caller MUST scrub secrets out of requestDetail first.
 */
export function logToolDecision(input: LogDecisionInput): DecisionEvent {
	return getDecisionAuditStore().logDecision(input);
}

/** Query the shared decision chain. Read-only. Newest first. */
export function queryToolDecisions(options: QueryDecisionOptions = {}): DecisionEvent[] {
	return getDecisionAuditStore().queryDecisions(options);
}

/** Recompute every hash in the shared chain and report the first broken link. */
export function verifyDecisionChain(): ChainVerification {
	return getDecisionAuditStore().verifyChain();
}
