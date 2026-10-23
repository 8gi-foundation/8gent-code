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
	/** The strict fingerprint: the same, but the cd prefix is kept. Only this one clears a denial. */
	sfp: string;
	/** Loose fingerprint, for matching: sha256 of the command, lowercased, whitespace collapsed, a leading cd prefix dropped. The command itself is never stored. */
	fp: string;
	/** What the person sees: the command, scrubbed of URL credentials and queries, cut to 120. */
	hint: string;
	at: string;
}

/** Most denials kept per session, and most session files kept. Both bound the disk. */
export const MAX_DENIALS_PER_SESSION = 50;
export const MAX_DENIAL_FILES = 100;

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

const squash = (c: string) => c.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Strict: the command as typed (trimmed, nothing else folded) plus the folder it ran
 * in, mirroring sessionKey(command, where). Clearing a denial uses this, so a yes to
 * another spelling, case, or folder clears nothing.
 */
export function strictFingerprint(command: string, where?: string): string {
	const key = where ? `${command.trim()}\u0000in ${where}` : command.trim();
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** Loose, for matching: a leading cd prefix is dropped, so a spelling of a denied call still asks. */
export function denialFingerprint(command: string): string {
	// The same call spelled with extra spaces or a leading `cd <dir> &&` is the same call.
	let bare = commandAfterCdPrefix(command, "/");
	bare = bare.replace(/^\s*cd[ \t]+[^;&\n]+?[ \t]*&&[ \t]*/, "");
	return createHash("sha256").update(squash(bare)).digest("hex").slice(0, 32);
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

export interface DenialFile {
	rows: DeniedCall[];
	/** The file exists but could not be read or parsed: callers fail closed. */
	corrupt: boolean;
}

/** The session's denials. A missing file is empty; an unreadable or unparsable one is corrupt. */
export function readDenialFile(sessionKey: string, dir?: string): DenialFile {
	const file = denialPath(sessionKey, dir);
	if (!file) return { rows: [], corrupt: false };
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { rows: [], corrupt: (err as NodeJS.ErrnoException)?.code !== "ENOENT" };
	}
	try {
		const parsed = JSON.parse(text) as { denied?: unknown };
		if (!Array.isArray(parsed?.denied)) return { rows: [], corrupt: true };
		// A row with a fingerprint is never dropped: dropping it would let the call run.
		// A missing strict fingerprint becomes one strictFingerprint cannot produce, so the
		// row matches loosely, asks every time, and no yes can clear it.
		const rows = parsed.denied
			.filter((d): d is Partial<DeniedCall> & { fp: string } => typeof d?.fp === "string")
			.map((d) => ({
				fp: d.fp,
				sfp: typeof d.sfp === "string" ? d.sfp : `legacy:${d.fp}`,
				hint: typeof d.hint === "string" ? d.hint : "(an earlier denial)",
				at: typeof d.at === "string" ? d.at : "",
			}))
			.slice(-MAX_DENIALS_PER_SESSION);
		return { rows, corrupt: false };
	} catch {
		return { rows: [], corrupt: true };
	}
}

/** The session's denials, or [] when none or the key is not a plain id. */
export function readDenials(sessionKey: string, dir?: string): DeniedCall[] {
	return readDenialFile(sessionKey, dir).rows;
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
export function recordDenial(
	sessionKey: string,
	command: string,
	where?: string,
	dir?: string,
): void {
	const sfp = strictFingerprint(command, where);
	const file = readDenialFile(sessionKey, dir);
	// Never write over a file that could not be read: the denials it held would be lost and
	// the session would fail open. It stays unreadable, so the session stays fail-closed.
	if (file.corrupt) throw new Error("the denial record is unreadable and was left as it is");
	const rows = file.rows.filter((d) => d.sfp !== sfp);
	rows.push({
		fp: denialFingerprint(command),
		sfp,
		hint: denialHint(command),
		at: new Date().toISOString(),
	});
	save(sessionKey, rows.slice(-MAX_DENIALS_PER_SESSION), dir);
}

/**
 * A fresh decision approved this exact call: its denial is gone. Only a row with
 * the same strict fingerprint goes; a yes to a different call that matches loosely
 * (another folder, case, spacing or the bare command) clears nothing. Writes no approval.
 */
export function clearDenial(
	sessionKey: string,
	command: string,
	where?: string,
	dir?: string,
): void {
	const sfp = strictFingerprint(command, where);
	const rows = readDenials(sessionKey, dir);
	if (rows.some((d) => d.sfp === sfp))
		save(
			sessionKey,
			rows.filter((d) => d.sfp !== sfp),
			dir,
		);
}

/** The lines shown on resume for each denied call. */
export function denialNotice(rows: readonly DeniedCall[]): string[] {
	return rows.map((d) => `Denied earlier in this session, needs a fresh decision: ${d.hint}`);
}

/** Shown once when a session's denial file exists but cannot be read. */
export const UNREADABLE_DENIALS_NOTICE =
	"This session's denial record could not be read, so every command asks until it is fixed.";
