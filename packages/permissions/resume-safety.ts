/**
 * Resume safety (#4821, Artale C2 and C3).
 *
 * C2: a resume after an interrupted turn never silently returns to the mode the
 * crash happened in. The tab starts in the stricter of (the mode it would have
 * restored, the default mode) and asks once to go back.
 *
 * C3: denials are persisted, approvals never are. A call a person (or the policy
 * card) denied is recorded in a small per-session ledger; on resume it is shown
 * as denied and PermissionManager asks again, even in Infinite or --yes, so a
 * `--durable-retry` run cannot re-run it without a fresh decision. The ledger has
 * no approval field and no approval API: there is nothing to replay.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrub } from "../eight/secret-scanner";
import { writeFileAtomic } from "./atomic-write";
import { commandAfterCdPrefix } from "./cd-prefix";
import { type PermissionMode, stricterMode } from "./permission-mode";

// ── C2: the mode a resume starts in ──────────────────────────────────

/** The mode a resume falls back to. The same default a fresh start uses without yolo. */
export const RESUME_DEFAULT_MODE: PermissionMode = "ask";

export interface ResumeLaunch {
	mode: PermissionMode;
	/** The launch mode was lowered: ask once to go back. */
	clamped: boolean;
}

/**
 * Where a tab starts. Only an interrupted resume is clamped; a fresh start, and
 * a resume of a turn that finished, keep `launch` (the user's yolo preference or
 * --infinite) exactly as it is.
 */
export function resumeLaunchMode(opts: {
	launch: PermissionMode;
	interrupted: boolean;
	fallback?: PermissionMode;
}): ResumeLaunch {
	if (!opts.interrupted) return { mode: opts.launch, clamped: false };
	const mode = stricterMode(opts.launch, opts.fallback ?? RESUME_DEFAULT_MODE);
	return { mode, clamped: mode !== opts.launch };
}

/** The one question after a clamped resume. `yolo` names the way back the person had chosen. */
export function resumeReturnQuestion(yolo: boolean): string {
	return `The last turn was cut off, so this session resumed in Ask. Go back to ${yolo ? "yolo" : "Infinite"}?`;
}

// ── C3: the denial ledger ────────────────────────────────────────────

export interface DeniedCall {
	/** sha256 of the command, lowercased, whitespace collapsed, a leading cd prefix dropped. The command itself is never stored. */
	fp: string;
	/** What the person sees: the command, scrubbed of URL credentials and queries, cut to 120. */
	hint: string;
	at: string;
}

/** Most denials kept per session, and most session files kept. Both bound the disk. */
export const MAX_DENIALS_PER_SESSION = 50;
export const MAX_DENIAL_FILES = 100;

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

export function denialFingerprint(command: string): string {
	// The same call spelled with extra spaces or a leading `cd <dir> &&` is the same call.
	let bare = commandAfterCdPrefix(command, "/");
	bare = bare.replace(/^\s*cd[ \t]+[^;&\n]+?[ \t]*&&[ \t]*/, "");
	const norm = bare.toLowerCase().replace(/\s+/g, " ").trim();
	return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

export function denialHint(command: string): string {
	return scrub(command)
		.scrubbed.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1")
		.replace(/(\w+:\/\/[^\s?"']*)\?[^\s"']*/g, "$1?...")
		.slice(0, 120);
}

export function denialDir(dir?: string): string {
	return path.join(
		dir ?? process.env.EIGHT_DATA_DIR ?? path.join(os.homedir(), ".8gent"),
		"denials",
	);
}

export function denialPath(sessionKey: string, dir?: string): string | null {
	return SAFE_KEY.test(sessionKey) ? path.join(denialDir(dir), `${sessionKey}.json`) : null;
}

/** The session's denials, or [] when none, unreadable, or the key is not a plain id. */
export function readDenials(sessionKey: string, dir?: string): DeniedCall[] {
	const file = denialPath(sessionKey, dir);
	if (!file) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { denied?: unknown };
		if (!Array.isArray(parsed.denied)) return [];
		return parsed.denied
			.filter(
				(d): d is DeniedCall =>
					typeof d?.fp === "string" && typeof d?.hint === "string" && typeof d?.at === "string",
			)
			.slice(-MAX_DENIALS_PER_SESSION);
	} catch {
		return [];
	}
}

function save(sessionKey: string, denied: DeniedCall[], dir?: string): void {
	const file = denialPath(sessionKey, dir);
	if (!file) return;
	if (denied.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileAtomic(file, `${JSON.stringify({ denied }, null, 2)}\n`);
	prune(path.dirname(file));
}

/** Keep the newest MAX_DENIAL_FILES session files. */
function prune(d: string): void {
	try {
		const files = fs
			.readdirSync(d)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		for (const { f } of files.slice(MAX_DENIAL_FILES)) fs.rmSync(path.join(d, f), { force: true });
	} catch {
		// Pruning is best effort.
	}
}

/** Record one denial. The same command twice is one row; the oldest rows fall off the cap. */
export function recordDenial(sessionKey: string, command: string, dir?: string): void {
	const fp = denialFingerprint(command);
	const rows = readDenials(sessionKey, dir).filter((d) => d.fp !== fp);
	rows.push({ fp, hint: denialHint(command), at: new Date().toISOString() });
	save(sessionKey, rows.slice(-MAX_DENIALS_PER_SESSION), dir);
}

/** A fresh decision approved this call: its denial is gone. Removes a row, writes no approval. */
export function clearDenial(sessionKey: string, command: string, dir?: string): void {
	const fp = denialFingerprint(command);
	const rows = readDenials(sessionKey, dir);
	if (rows.some((d) => d.fp === fp))
		save(
			sessionKey,
			rows.filter((d) => d.fp !== fp),
			dir,
		);
}

/** The lines shown on resume for each denied call. */
export function denialNotice(rows: readonly DeniedCall[]): string[] {
	return rows.map((d) => `Denied before the crash, needs a fresh decision: ${d.hint}`);
}
