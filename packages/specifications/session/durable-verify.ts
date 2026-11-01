/**
 * Durable turns, slice 3 (docs/specs/DURABLE-TURNS.md): verified effects.
 *
 * Slice 1 records an intent before a tool runs and an effect after. A kill in
 * between leaves the call open, and the person decides. This module removes the
 * question where the answer can be checked:
 *
 * - Every intent carries the build that started it (version plus git sha, or
 *   EIGHT_BUILD_ID). A resume under another build says so before any retry.
 * - write_file and edit_file intents carry the sha256 of the content the file
 *   will hold once the call lands. If the file already holds it, the call is done.
 * - git_commit intents carry HEAD, the index tree and the message. If HEAD is
 *   that commit, the call is done.
 * - Any other tool that changes something (run_command, a terminal, MCP, the
 *   desktop) carries nothing to check: it is always asked, never redone.
 * - Headless `8gent -p` never prompts: open calls are printed and the run exits
 *   with DURABLE_EXIT unless --durable-retry or --durable-skip says what to do.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type IntentRecord,
	appendRecord,
	interruptedCalls,
	planResume,
	resumeNotice,
} from "./durable-ledger.js";

/** What resume checks to decide a call already landed. Hashes are full sha256 hex. */
export type EffectCheck =
	| { t: "file"; path: string; root: string; want: string }
	| { t: "commit"; dir: string; head: string | null; index: string; msg: string };

/** Exit code of a headless run stopped by open calls: distinct from a failed run (1). */
export const DURABLE_EXIT = 3;

/** The tools whose effect resume can check. The only changing tools a retry run may use. */
export const VERIFIABLE: ReadonlySet<string> = new Set(["write_file", "edit_file", "git_commit"]);

/**
 * Never redone by 8gent: every tool that is neither read-only nor verifiable
 * (commands, terminals, MCP, the desktop, extensions). Asked, never retried.
 */
export function neverRetried(tool: string, readOnly: ReadonlySet<string>): boolean {
	return !VERIFIABLE.has(tool) && !readOnly.has(tool);
}

/**
 * What a --durable-retry run may offer and run: read-only tools plus the verifiable
 * ones. An allowlist, not a denylist, so a new tool that runs something is off by default.
 */
export function retryAllowlist(readOnly: ReadonlySet<string>): string[] {
	return [...readOnly, ...VERIFIABLE];
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// Edits are checked only on files a phone can hash quickly.
const MAX_CHECK_BYTES = 8 * 1024 * 1024;

let root: string | null = null;
/** The folder relative tool paths resolve against (the 8gent's working directory). */
export function setDurableRoot(dir: string | null): void {
	root = dir;
}
function workRoot(): string {
	return root ?? process.env.EIGHT_WORKSPACE_ROOT ?? process.cwd();
}

let build: string | null = null;
/**
 * The build that is running: EIGHT_BUILD_ID when the release set one, else the
 * package version plus the checkout's git sha (version alone on an npm install).
 */
export function buildSignature(): string {
	if (build) return build;
	if (process.env.EIGHT_BUILD_ID) return (build = process.env.EIGHT_BUILD_ID);
	const pkgRoot = path.resolve(import.meta.dir, "..", "..", "..");
	let version = "unknown";
	try {
		version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
	} catch {}
	const git = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
		cwd: pkgRoot,
		encoding: "utf8",
		timeout: 2000,
	});
	const sha = git.status === 0 ? git.stdout.trim() : "";
	build = sha ? `${version}+${sha}` : version;
	return build;
}
/** Tests only: forget the cached signature. */
export function resetBuildSignature(): void {
	build = null;
}

function git(dir: string, args: string[]): string | null {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 });
	return r.status === 0 ? r.stdout : null;
}

/** `git commit -m` cleanup ("whitespace"): trailing spaces, outer and repeated blank lines. */
export function normalizeCommitMessage(m: string): string {
	return m
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The real path of `abs` (or of its nearest existing folder, for a file not made
 * yet) lies inside `root`'s real path. Symlinked parents and ../ resolve first.
 */
export function insideRoot(abs: string, root: string): boolean {
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(root);
	} catch {
		return false;
	}
	let probe = abs;
	let rest = "";
	for (;;) {
		try {
			const real = path.join(fs.realpathSync(probe), rest);
			return real === realRoot || real.startsWith(realRoot + path.sep);
		} catch {
			const up = path.dirname(probe);
			if (up === probe) return false;
			rest = path.join(path.basename(probe), rest);
			probe = up;
		}
	}
}

/** A regular file inside the work root, small enough to hash on a phone; else null. */
function readSmallFile(abs: string, root: string): string | null {
	if (!insideRoot(abs, root)) return null;
	try {
		const st = fs.lstatSync(abs);
		if (!st.isFile() || st.size > MAX_CHECK_BYTES) return null;
		return fs.readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/**
 * Called when the intent is written, before the tool runs. Returns what resume
 * will check, or undefined when the outcome cannot be checked (it is then asked).
 */
export function effectCheck(
	tool: string,
	args: Record<string, unknown> | undefined,
): EffectCheck | undefined {
	if (!args) return undefined;
	const p = typeof args.path === "string" ? args.path : undefined;
	const dir = workRoot();
	// A path outside the project is never read here: it carries no check and is asked.
	const abs = p && insideRoot(path.resolve(dir, p), dir) ? path.resolve(dir, p) : undefined;
	if (tool === "write_file" && abs && typeof args.content === "string")
		return { t: "file", path: abs, root: dir, want: sha256(args.content) };
	if (tool === "edit_file" && abs) {
		// An anchored edit (#3472) or a fuzzy match cannot be predicted: only an exact,
		// unique old text gives one known result.
		if (args.anchor !== undefined && args.anchor !== "") return undefined;
		const oldText = args.oldText;
		const newText = args.newText;
		if (typeof oldText !== "string" || typeof newText !== "string" || !oldText) return undefined;
		if (oldText === newText) return undefined;
		const cur = readSmallFile(abs, dir);
		if (cur === null) return undefined;
		const i = cur.indexOf(oldText);
		if (i === -1 || cur.indexOf(oldText, i + 1) !== -1) return undefined;
		const after = cur.slice(0, i) + newText + cur.slice(i + oldText.length);
		return { t: "file", path: abs, root: dir, want: sha256(after) };
	}
	if (tool === "git_commit" && typeof args.message === "string") {
		// The index the commit will record, read without writing any object.
		const index = indexDigest(dir);
		if (!index) return undefined;
		const head = git(dir, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
		return { t: "commit", dir, head, index, msg: sha256(normalizeCommitMessage(args.message)) };
	}
	return undefined;
}

/**
 * One digest for "these paths at these blobs", the same from the index
 * (`ls-files -s`, read only) and from HEAD's tree (`ls-tree -r`), so the
 * intent never has to write a tree object to know what the commit will hold.
 */
function digestEntries(lines: string[]): string {
	return sha256(lines.sort().join("\0"));
}
function indexDigest(dir: string): string | null {
	const out = git(dir, ["ls-files", "-s", "-z"]);
	if (out === null) return null;
	const rows: string[] = [];
	for (const rec of out.split("\0").filter(Boolean)) {
		const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
		if (!m || m[3] !== "0") return null; // a conflicted index commits nothing
		rows.push(`${m[1]} ${m[2]}\t${m[4]}`);
	}
	return digestEntries(rows);
}
function headTreeDigest(dir: string): string | null {
	const out = git(dir, ["ls-tree", "-r", "-z", "HEAD"]);
	if (out === null) return null;
	const rows: string[] = [];
	for (const rec of out.split("\0").filter(Boolean)) {
		const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(rec);
		if (!m) return null;
		rows.push(`${m[1]} ${m[2]}\t${m[3]}`);
	}
	return digestEntries(rows);
}

/** True when what the call meant to do is already there. */
export function effectLanded(check: EffectCheck): boolean {
	if (check.t === "file") {
		const cur = readSmallFile(check.path, check.root);
		return cur !== null && sha256(cur) === check.want;
	}
	const out = git(check.dir, ["log", "-1", "--format=%P%x00%B", "HEAD"]);
	if (!out) return false;
	const [parents, body] = out.split("\0");
	const parent = parents.trim().split(" ")[0] || null;
	return (
		headTreeDigest(check.dir) === check.index &&
		parent === check.head &&
		sha256(normalizeCommitMessage(body ?? "")) === check.msg
	);
}

/** Close every open call whose effect is verifiably on disk. Returns the closed calls. */
export function settleVerified(key: string): IntentRecord[] {
	const done: IntentRecord[] = [];
	const at = new Date().toISOString();
	for (const c of interruptedCalls(key)) {
		if (!VERIFIABLE.has(c.tool) || !c.check || !effectLanded(c.check)) continue;
		appendRecord(key, { k: "resolve", id: c.id, how: "verified", at });
		done.push(c);
	}
	return done;
}

/** A line naming the build gap, or null when every open call came from this build. */
export function buildNote(open: IntentRecord[]): string | null {
	const now = buildSignature();
	const other = [...new Set(open.map((c) => c.build).filter((b) => b && b !== now))];
	if (other.length === 0) return null;
	return `These calls were started by 8gent ${other.join(", ")}; this is ${now}. Tools may behave differently: check the state yourself before a retry.`;
}

const label = (c: IntentRecord) => `${c.tool}${c.hint ? ` ${c.hint}` : ""}`;

/**
 * The resume report with slice 3 applied: calls already on disk are closed and
 * named, a build change is said before any retry is offered.
 */
export function durableResumeNotice(
	key: string,
	isReadOnly: (tool: string) => boolean,
): string | null {
	const verified = settleVerified(key);
	const open = interruptedCalls(key);
	const lines: string[] = [];
	for (const c of verified) lines.push(`Already done, not redone: ${label(c)}.`);
	const note = buildNote(open);
	if (note) lines.push(note);
	const base = resumeNotice(planResume(open, isReadOnly));
	if (base) lines.push(base);
	return lines.length ? lines.join("\n") : null;
}

export interface HeadlessGate {
	/** Set when the run must stop: print `text` on stderr and exit with this code. */
	exit?: number;
	/** What to tell the person on stderr. */
	text: string[];
	/** Put ahead of the prompt on --durable-retry. */
	preamble?: string;
	/** The open calls, for a stream-json event. */
	open: IntentRecord[];
	/** On --durable-retry: the only tools the run may offer or run (retryAllowlist). */
	allow?: string[];
}

/**
 * Headless resume (`8gent -p --resume <id>`): never prompts. Calls already on disk
 * are closed. Anything else stops the run with DURABLE_EXIT, unless the caller
 * passed --durable-skip (close and carry on) or --durable-retry (8gent checks and
 * redoes what is missing; a command is never run again).
 */
export function headlessDurableGate(
	key: string,
	choice: { retry: boolean; skip: boolean },
	readOnly: ReadonlySet<string>,
): HeadlessGate {
	const text: string[] = [];
	for (const c of settleVerified(key)) text.push(`[durable] already done, not redone: ${label(c)}`);
	const open = interruptedCalls(key);
	if (open.length === 0) return { text, open };
	if (choice.retry && choice.skip)
		return {
			exit: 1,
			open,
			text: [...text, "Error: pass --durable-retry or --durable-skip, not both."],
		};
	text.push(
		`[durable] session ${key}: the last turn was cut off with ${open.length} call(s) open:`,
	);
	for (const c of open) text.push(`[durable]   ${label(c)} (started ${c.at})`);
	const note = buildNote(open);
	if (note) text.push(`[durable] ${note}`);
	const at = new Date().toISOString();
	if (choice.skip) {
		for (const c of open) appendRecord(key, { k: "resolve", id: c.id, how: "skip", at });
		text.push("[durable] --durable-skip: left as they are.");
		return { text, open };
	}
	if (choice.retry) {
		const commands = open.filter((c) => neverRetried(c.tool, readOnly));
		const redo = open.filter((c) => !neverRetried(c.tool, readOnly));
		for (const c of commands) appendRecord(key, { k: "resolve", id: c.id, how: "skip", at });
		for (const c of redo) appendRecord(key, { k: "resolve", id: c.id, how: "retry", at });
		if (commands.length)
			text.push(
				`[durable] not redone (8gent cannot check it, so never repeats it): ${commands.map(label).join("; ")}`,
			);
		// The preamble alone does not stop a re-run, and --yes approves commands: the
		// retry run gets only read-only and verifiable tools; the rest are refused.
		const allow = retryAllowlist(readOnly);
		text.push(`[durable] this run may only read and use ${[...VERIFIABLE].join(", ")}.`);
		if (redo.length === 0) return { text, open, allow };
		const preamble = [
			"[durable] My last turn was interrupted before these tool calls recorded a result:",
			...redo.map((c) => `- ${label(c)} (may or may not have happened)`),
			...commands.map((c) => `- ${label(c)} (not redone: do not run it again)`),
			"Check the current state first (read the file, git status, list the output). Then redo only what is missing. Do not repeat a change that already landed.",
		].join("\n");
		return { text, open, preamble, allow };
	}
	text.push(
		"[durable] Nothing was run. Pass --durable-retry (check, then redo what is missing) or --durable-skip (leave it).",
	);
	return { exit: DURABLE_EXIT, text, open };
}
