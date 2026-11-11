/**
 * Session usage records (issue #222, slice 1).
 *
 * One JSON file per session under <data dir>/session-usage/. Local only:
 * no network, no model call, no background service. Format: see
 * docs/specs/SESSION-USAGE-RECORD.md.
 */

import * as crypto from "node:crypto";
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
/** Largest record file that is read; anything bigger is skipped. */
export const MAX_RECORD_BYTES = 64 * 1024;
/** Longest session name kept when a record is parsed. */
export const MAX_SESSION_CHARS = 200;
/** Longest string printed to a terminal in one cell or line. */
export const MAX_PRINT_CHARS = 120;

/** Same resolution as packages/daemon/data-dir.ts, kept local so this package has no imports. */
export function usageDir(): string {
	const root = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(root, "session-usage");
}

/**
 * File-name stem for a session. Clean names up to 120 characters are used as
 * they are. Any other name is cleaned, cut, and given "-" plus 8 hex characters
 * of the SHA-256 of the original, so two different sessions never share a file.
 */
export function safeName(session: string): string {
	const cleaned = session.replace(/[^A-Za-z0-9._-]/g, "_");
	if (cleaned === session && session.length > 0 && session.length <= 120) return session;
	const hash = crypto.createHash("sha256").update(session).digest("hex").slice(0, 8);
	return `${cleaned.slice(0, 120) || "unnamed"}-${hash}`;
}

/**
 * Make a stored string safe to print: C0, DEL and C1 control characters become
 * "?" and the length is capped, so a hostile value cannot drive the terminal.
 */
export function printable(s: string, max = MAX_PRINT_CHARS): string {
	return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, max);
}

/**
 * Write atomically: exclusive temp file in the same folder, then rename over
 * the record. The folder is created 0o700 and files 0o600. An existing folder
 * is left as it is. If anything already sits at the temp name the write fails
 * and that file is not touched.
 */
export function writeRecord(record: SessionUsageRecord, dir = usageDir()): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${safeName(record.session)}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.writeSync(fd, `${JSON.stringify(record)}\n`);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
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
			session: o.session.slice(0, MAX_SESSION_CHARS),
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
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
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
		printable(r.session),
		printable(unk(r.account)),
		printable(unk(r.harness)),
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
