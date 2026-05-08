/**
 * Handoff audit log (issue #2422).
 *
 * Append-only JSONL store for every agent-to-agent handoff. One line per
 * record. Captures the handoff envelope, result, timing, and depth so a
 * post-mortem can reconstruct any delegation chain end-to-end.
 *
 * Why JSONL: zero ceremony, replay-friendly, grep-friendly, survives a
 * crash mid-write (one bad line ≠ one corrupt DB).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentHandoff, HandoffResult } from "../handoff";

export interface HandoffAuditRecord {
	/** When the dispatcher accepted the handoff. */
	startedAt: number;
	/** When the result landed (or the timeout fired). */
	completedAt: number;
	/** Depth at which this handoff ran. 0 = root, 1 = first delegation. */
	depth: number;
	/** Parent handoff id, if this was issued from inside another. */
	parentId: string | null;
	/** The original envelope, verbatim. */
	handoff: AgentHandoff;
	/** What came back. */
	result: HandoffResult;
}

export interface HandoffAuditQuery {
	/** Limit by source agent. */
	from?: string;
	/** Limit by target agent. */
	to?: string;
	/** Only records since this epoch ms. */
	since?: number;
	/** Only records up to this epoch ms. */
	until?: number;
	/** Only records with this status. */
	status?: HandoffResult["status"];
	/** Cap the result count. */
	limit?: number;
}

/**
 * Append-only audit log. One file, one line per record.
 *
 * Reads are linear (full file scan) on purpose. The expected volume is
 * small (handoffs are coarse-grained) and JSONL keeps us out of database
 * land for a feature that just needs a ledger.
 */
export class HandoffAuditLog {
	constructor(private readonly path: string) {
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	record(entry: HandoffAuditRecord): void {
		const line = `${JSON.stringify(entry)}\n`;
		appendFileSync(this.path, line);
	}

	query(filter: HandoffAuditQuery = {}): HandoffAuditRecord[] {
		if (!existsSync(this.path)) return [];
		const raw = readFileSync(this.path, "utf-8");
		const out: HandoffAuditRecord[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let rec: HandoffAuditRecord;
			try {
				rec = JSON.parse(line) as HandoffAuditRecord;
			} catch {
				continue;
			}
			if (filter.from && rec.handoff.from !== filter.from) continue;
			if (filter.to && rec.handoff.to !== filter.to) continue;
			if (filter.status && rec.result.status !== filter.status) continue;
			if (filter.since && rec.startedAt < filter.since) continue;
			if (filter.until && rec.startedAt > filter.until) continue;
			out.push(rec);
		}
		if (filter.limit && out.length > filter.limit) {
			return out.slice(out.length - filter.limit);
		}
		return out;
	}

	get filePath(): string {
		return this.path;
	}
}

/** Default location: ~/.8gent/handoff-audit.jsonl. */
export function defaultHandoffLogPath(): string {
	const dataDir = process.env.EIGHT_DATA_DIR || `${process.env.HOME}/.8gent`;
	return `${dataDir}/handoff-audit.jsonl`;
}
