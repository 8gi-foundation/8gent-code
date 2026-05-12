/**
 * Append-only audit log writer for the store RPC layer.
 *
 * Two log files under `~/.8gent/audit/`:
 *   - kg-ops.jsonl    KG add/delete operations (8SO requirement)
 *   - exec-ops.jsonl  fs.exec shell-command attempts and outcomes
 *
 * Best-effort: never throws, never blocks the RPC. If the audit dir cannot
 * be created or the file cannot be written, the operation logs a warning
 * to stderr and continues. The RPC must not depend on audit success.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { getDataDir } from "../../data-dir";

let _auditDir: string | null = null;

function auditDir(): string {
	if (_auditDir) return _auditDir;
	const dir = path.join(getDataDir(), "audit");
	if (!existsSync(dir)) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch (err) {
			console.warn("[store-audit] failed to create audit dir:", (err as Error).message);
		}
	}
	_auditDir = dir;
	return dir;
}

export interface KgAuditEntry {
	op: "add" | "delete" | "blocked";
	file?: string;
	chunkId?: string;
	chunks?: number;
	embeddingModel?: string;
	scope?: "conversation" | "global";
	conversationId?: string | null;
	initiator?: string;
	sessionId?: string | null;
	reason?: string;
}

export interface ExecAuditEntry {
	op: "exec" | "denied";
	command: string;
	workspaceId: string;
	workspaceRoot?: string;
	conversationId: string;
	initiator: string;
	exitCode?: number;
	durationMs?: number;
	reason?: string;
	bypass?: boolean;
}

function append(filename: string, entry: Record<string, unknown>): void {
	try {
		const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
		appendFileSync(path.join(auditDir(), filename), line);
	} catch (err) {
		// Audit failure must never break the RPC; surface a single warning.
		console.warn("[store-audit] write failed:", (err as Error).message);
	}
}

export function logKgOp(entry: KgAuditEntry): void {
	append("kg-ops.jsonl", { ...entry } as Record<string, unknown>);
}

export function logExecOp(entry: ExecAuditEntry): void {
	append("exec-ops.jsonl", { ...entry } as Record<string, unknown>);
}

/** Test hook: override the audit dir so tests don't pollute ~/.8gent. */
export function _setAuditDir(dir: string): void {
	_auditDir = dir;
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
