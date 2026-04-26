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

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { AccessAuditStore } from "./store.js";
import type {
	AccessEvent,
	AccessOperation,
	ActorKind,
	LogAccessInput,
	QueryAccessOptions,
} from "./types.js";

export { AccessAuditStore };
export type {
	AccessEvent,
	AccessOperation,
	ActorKind,
	LogAccessInput,
	QueryAccessOptions,
};

let _shared: AccessAuditStore | null = null;
let _sharedPath: string | null = null;

function resolveDefaultPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	const dir = path.join(base, "audit");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "access.db");
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
