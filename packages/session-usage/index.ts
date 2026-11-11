/**
 * Session usage records (issue #222, slice 1).
 *
 * One JSON file per session under <data dir>/session-usage/. Local only:
 * no network, no model call, no background service. Format: see
 * docs/specs/SESSION-USAGE-RECORD.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionUsageRecord {
	version: 1;
	session: string;
	workspace: string | null;
	harness: string | null;
	/** A label the user sets. Never a credential. */
	account: string | null;
	contextUsed: number | null;
	contextWindow: number | null;
	/** Percent (0-100) of the account limit used, null when not reported. */
	usagePct: number | null;
	/** ISO 8601 time the reader last wrote this record. */
	updatedAt: string;
}

export interface SessionUsageRow extends SessionUsageRecord {
	stale: boolean;
	/** Context used as a percent of the window, null when either number is unknown. */
	contextPct: number | null;
}

export const DEFAULT_STALE_MS = 5 * 60 * 1000;

/** Same resolution as packages/daemon/data-dir.ts, kept local so this package has no imports. */
export function usageDir(): string {
	const root = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(root, "session-usage");
}

export function safeName(session: string): string {
	return session.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unnamed";
}

/** Write atomically: temp file in the same folder, then rename over the record. */
export function writeRecord(record: SessionUsageRecord, dir = usageDir()): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${safeName(record.session)}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
	fs.renameSync(tmp, file);
	return file;
}

const numOrNull = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

function parseRecord(raw: string): SessionUsageRecord | null {
	try {
		const o = JSON.parse(raw);
		if (!o || o.version !== 1 || typeof o.session !== "string") return null;
		if (typeof o.updatedAt !== "string" || Number.isNaN(Date.parse(o.updatedAt))) return null;
		return {
			version: 1,
			session: o.session,
			workspace: strOrNull(o.workspace),
			harness: strOrNull(o.harness),
			account: strOrNull(o.account),
			contextUsed: numOrNull(o.contextUsed),
			contextWindow: numOrNull(o.contextWindow),
			usagePct: numOrNull(o.usagePct),
			updatedAt: o.updatedAt,
		};
	} catch {
		return null;
	}
}

export function readRecord(file: string): SessionUsageRecord | null {
	try {
		return parseRecord(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** All records, nearest limit first. Unknown usage sorts last, then by context fill. */
export function listSessions(
	opts: { dir?: string; now?: number; staleMs?: number } = {},
): SessionUsageRow[] {
	const dir = opts.dir ?? usageDir();
	const now = opts.now ?? Date.now();
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const rows: SessionUsageRow[] = [];
	for (const n of names) {
		const r = readRecord(path.join(dir, n));
		if (!r) continue;
		const contextPct =
			r.contextUsed !== null && r.contextWindow
				? (r.contextUsed / r.contextWindow) * 100
				: null;
		rows.push({ ...r, contextPct, stale: now - Date.parse(r.updatedAt) > staleMs });
	}
	const key = (v: number | null) => (v === null ? -1 : v);
	return rows.sort(
		(a, b) =>
			key(b.usagePct) - key(a.usagePct) ||
			key(b.contextPct) - key(a.contextPct) ||
			a.session.localeCompare(b.session),
	);
}

const unk = (v: string | null) => v ?? "unknown";
const pct = (v: number | null) => (v === null ? "unknown" : `${Math.round(v)}%`);

export function formatRows(rows: SessionUsageRow[]): string {
	if (rows.length === 0) return "No session records.";
	const head = ["SESSION", "ACCOUNT", "HARNESS", "CONTEXT", "LIMIT", "STATE"];
	const body = rows.map((r) => [
		r.session,
		unk(r.account),
		unk(r.harness),
		pct(r.contextPct),
		pct(r.usagePct),
		r.stale ? "stale" : "live",
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
	const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
	return [line(head), ...body.map(line)].join("\n");
}

if (import.meta.main) {
	console.log(formatRows(listSessions()));
}
