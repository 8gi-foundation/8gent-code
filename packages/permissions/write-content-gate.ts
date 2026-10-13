/**
 * 8gent Code - one write-policy gate for every tool that puts text on disk.
 *
 * Issue #3011: the no-secrets-in-files rule (`content has_secret`) only ever
 * saw write_file's `content`. edit_file carries its text in `newText`, the
 * notebook tools in `newSource` / `source`, so a credential could land on
 * disk through an edit and the rule never looked at it. On the AI SDK path
 * (packages/ai/tools.ts) no write tool was gated at all.
 *
 * Both tool paths now ask this module what a call is about to write and run
 * that through ToolG8 as a `write_file` action, so every write tool gets the
 * same policies, audit entry and blocked message as write_file.
 *
 * What an edit is checked on: the full LINES of the resulting file that the
 * edit touches. Not the whole file, because a secret-shaped fixture elsewhere
 * in the file was not added by this edit and must not block it. Not newText
 * alone, because an edit can finish a credential that is split across the
 * boundary (`aws_secret_access_key = ` already on the line, the value in
 * newText). A line the edit rewrites is content the edit writes, exactly as
 * write_file would.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolG8 } from "./toolg8.js";

/** Tools whose arguments carry text that is written into a file. */
export const WRITE_CONTENT_TOOLS = new Set<string>([
	"write_file",
	"edit_file",
	"notebook_edit_cell",
	"notebook_insert_cell",
	"write_notes",
]);

/** Where an edit lands: one offset, nothing, or a refusal to guess. */
export type EditTarget =
	| { kind: "ok"; idx: number }
	| { kind: "none" }
	| { kind: "ambiguous"; lines: number[]; more: boolean }
	| { kind: "none-after"; startLine: number; lines: number[]; more: boolean }
	/** A whitespace-only match was found but applying it would change bytes the model did not ask to change. */
	| { kind: "ws-refused"; reason: string; lines: number[]; more: boolean };

/** Match lines kept for a refusal; past this the text says "N+". */
export const MAX_REPORTED_MATCHES = 20;
const MAX_PATH_CHARS = 200;
const LOG_ROTATE_BYTES = 1024 * 1024;

const clipPath = (p: string) => (p.length > MAX_PATH_CHARS ? `${p.slice(0, MAX_PATH_CHARS)}...` : p);

/**
 * Find where oldText goes (#3898). Zero matches: "none". One match: it.
 * Several matches and no startLine: "ambiguous", never a silent first-match.
 * With startLine, the first match that starts at or after that 1-based line
 * wins; if every match is earlier the file is not what the model read, so
 * "none-after" refuses rather than editing the wrong copy.
 *
 * One forward pass: line numbers come from a cursor that only moves ahead,
 * and without startLine the scan stops after MAX_REPORTED_MATCHES matches.
 * Overlapping matches count ("aa" in "aaa" is two), because an overlapping
 * oldText is still an ambiguous anchor.
 */
export function locateEdit(original: string, oldText: string, startLine?: number): EditTarget {
	// indexOf("", i) never returns -1, so an empty oldText would loop forever.
	if (oldText === "") return { kind: "none" };
	const anchored = typeof startLine === "number" && Number.isFinite(startLine);
	const lines: number[] = [];
	let count = 0;
	let firstIdx = -1;
	let line = 1;
	let nl = original.indexOf("\n");
	for (let i = original.indexOf(oldText); i !== -1; i = original.indexOf(oldText, i + 1)) {
		while (nl !== -1 && nl < i) {
			line++;
			nl = original.indexOf("\n", nl + 1);
		}
		if (count === 0) firstIdx = i;
		count++;
		if (anchored && line >= (startLine as number)) return { kind: "ok", idx: i };
		if (lines.length < MAX_REPORTED_MATCHES) lines.push(line);
		else if (!anchored) break;
	}
	if (count === 0) return { kind: "none" };
	const more = count > MAX_REPORTED_MATCHES;
	if (anchored) return { kind: "none-after", startLine: startLine as number, lines, more };
	if (count > 1) return { kind: "ambiguous", lines, more };
	return { kind: "ok", idx: firstIdx };
}

const lineList = (t: { lines: number[]; more: boolean }) =>
	`${t.lines.join(", ")}${t.more ? ", ..." : ""}`;

/** Model-visible refusal for a duplicate or stale-anchored edit, or null if the edit can proceed. */
export function editRefusal(target: EditTarget | ResolvedEdit, filePath: string): string | null {
	const p = clipPath(filePath);
	if (target.kind === "ambiguous") {
		const n = target.more ? `${MAX_REPORTED_MATCHES}+` : String(target.lines.length);
		return `Error: oldText matches ${n} times in ${p} (lines ${lineList(target)}). Nothing was written. Add surrounding lines to oldText so it is unique, or pass startLine to pick the copy at or after that line.`;
	}
	if (target.kind === "ws-refused") {
		return `Error: oldText did not match exactly; the only candidate (after whitespace matching, line ${target.lines[0]}) was refused: ${target.reason} Nothing was written. read_file the region and retry with its exact text.`;
	}
	if (target.kind === "none-after") {
		return `Error: oldText matches in ${p} only before line ${target.startLine} (lines ${lineList(target)}). Nothing was written. The file may have changed since you read it: read_file again and retry.`;
	}
	return null;
}

/**
 * Count refused edits (#3898): one JSON line per refusal in
 * ~/.8gent/edit-ambiguous.jsonl, rotated to .1 at 1 MB. No file text is
 * logged, only the clipped path, up to 20 match lines and the oldText length.
 * Never throws.
 */
export function logEditRefusal(target: EditTarget | ResolvedEdit, filePath: string, oldTextLength: number): void {
	if (target.kind !== "ambiguous" && target.kind !== "none-after" && target.kind !== "ws-refused") return;
	try {
		const dir = path.join(process.env.HOME || os.homedir(), ".8gent");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "edit-ambiguous.jsonl");
		try {
			if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
		} catch {
			// No log yet.
		}
		const rec = {
			ts: new Date().toISOString(),
			kind: target.kind,
			path: clipPath(filePath),
			lines: target.lines,
			more: target.more,
			oldTextLength,
		};
		fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
	} catch {
		// Logging must never change the edit's outcome.
	}
}

/** What an edit resolves to: the splice to perform, or why not. */
export type ResolvedEdit =
	| {
			kind: "ok";
			idx: number;
			oldLength: number;
			newText: string;
			/** 1-based line of a whitespace-only match; undefined for an exact match. */
			matchedLine?: number;
	  }
	| Exclude<EditTarget, { kind: "ok" }>;

/** Work budget for the whitespace scan, in characters compared plus one per line; past it, no guess. */
export const MAX_WS_COMPARISONS = 20_000_000;
/** Lines longer than this are never whitespace-matched (minified or generated text). */
const MAX_WS_LINE = 4096;

const stripLine = (l: string) => l.replace(/^\s+|\s+$/g, "");
const leadWs = (l: string) => /^[ \t]*/.exec(l)?.[0] ?? "";

/**
 * Re-indent newText by the leading-whitespace mapping the matched block
 * implies (oldText line indent -> file line indent). Null when the mapping is
 * not a function or a newText line has an indent that is not in the map (no prefix
 * guessing: nested lines would be shifted once instead of scaled).
 */
function reindent(oldLines: string[], fileLines: string[], newText: string): string | null {
	const map = new Map<string, string>();
	for (let i = 0; i < oldLines.length; i++) {
		if (stripLine(oldLines[i]) === "") continue;
		const a = leadWs(oldLines[i]);
		const b = leadWs(fileLines[i]);
		if (map.has(a) && map.get(a) !== b) return null;
		map.set(a, b);
	}
	if (map.size === 0) return null;
	if ([...map].every(([a, b]) => a === b)) return newText;
	const out: string[] = [];
	for (const line of newText.split("\n")) {
		if (stripLine(line) === "") {
			out.push(line);
			continue;
		}
		const l = leadWs(line);
		const rest = line.slice(l.length);
		const direct = map.get(l);
		if (direct !== undefined) out.push(direct + rest);
		else return null;
	}
	return out.join("\n");
}

/**
 * One resolver for every edit_file path (tools.ts, packages/ai/tools.ts and
 * the write gate), so the gate checks the bytes that are written.
 *
 * Exact match first (locateEdit rules). If there is none, a block that matches
 * line for line with only leading/trailing whitespace stripped (CR included,
 * never internal collapse) and is unique (or picked by startLine) is used,
 * with newText re-indented by the block's own indent mapping. Refused, never
 * guessed: inconsistent indent mapping, CRLF mismatch, and markdown hard
 * breaks (trailing two spaces) that the edit would drop.
 */
export function resolveEdit(
	original: string,
	oldText: string,
	newText: string,
	startLine?: number,
	filePath?: string,
): ResolvedEdit {
	const t = locateEdit(original, oldText, startLine);
	if (t.kind === "ok") return { kind: "ok", idx: t.idx, oldLength: oldText.length, newText };
	if (t.kind !== "none") return t;

	const lines = original.split("\n");
	const want = oldText.split("\n");
	const trailingNewline = want.length > 1 && want[want.length - 1] === "";
	if (trailingNewline) want.pop();
	if (want.length === 0 || stripLine(oldText) === "") return t;
	if (want.some((l) => l.length > MAX_WS_LINE)) return t;
	const wantS = want.map(stripLine);
	const fileS = lines.map((l) => (l.length > MAX_WS_LINE ? null : stripLine(l)));
	const anchored = typeof startLine === "number" && Number.isFinite(startLine);

	let budget = MAX_WS_COMPARISONS;
	const found: number[] = [];
	for (let i = 0; i + want.length <= lines.length; i++) {
		budget -= 1 + wantS[0].length;
		if (budget < 0) return t;
		if (fileS[i] !== wantS[0]) continue;
		let ok = true;
		for (let j = 1; j < want.length; j++) {
			budget -= 1 + wantS[j].length;
			if (budget < 0) return t;
			if (fileS[i + j] !== wantS[j]) {
				ok = false;
				break;
			}
		}
		if (ok) found.push(i);
		if (found.length > MAX_REPORTED_MATCHES) break;
	}
	let at: number;
	if (anchored) {
		const pick = found.find((i) => i + 1 >= (startLine as number));
		if (pick === undefined) return t;
		at = pick;
	} else {
		if (found.length !== 1) return t;
		at = found[0];
	}
	if (trailingNewline && at + want.length >= lines.length) return t;

	const refuse = (reason: string): ResolvedEdit => ({ kind: "ws-refused", reason, lines: [at + 1], more: false });
	const fileBlock = lines.slice(at, at + want.length);
	const fileHasCr = fileBlock.some((l) => l.endsWith("\r"));
	if (fileHasCr !== oldText.includes("\r")) {
		return refuse("the file block uses different line endings (CRLF) than oldText, so the file would end up mixed.");
	}
	if (fileHasCr && !newText.split("\n").slice(0, -1).every((l) => l.endsWith("\r"))) {
		return refuse("the file block uses CRLF but newText lines do not end with CR.");
	}
	if (filePath && /\.(md|markdown|mdx)$/i.test(filePath)) {
		for (let j = 0; j < want.length; j++) {
			if (/\S {2,}\r?$/.test(fileBlock[j]) && !/\S {2,}\r?$/.test(want[j])) {
				return refuse("it would drop a markdown hard line break (two trailing spaces).");
			}
		}
	}
	const re = reindent(want, fileBlock, newText);
	if (re === null) return refuse("the indentation of oldText does not map consistently onto the file, so newText cannot be re-indented safely.");

	let offset = 0;
	for (let i = 0; i < at; i++) offset += lines[i].length + 1;
	let oldLength = fileBlock.reduce((n, l) => n + l.length, 0) + (fileBlock.length - 1);
	if (trailingNewline) oldLength += 1;
	// A CR on the block's last line that oldText did not send stays in the file.
	else if (fileBlock[fileBlock.length - 1].endsWith("\r") && !want[want.length - 1].endsWith("\r")) oldLength -= 1;
	return { kind: "ok", idx: offset, oldLength, newText: re, matchedLine: at + 1 };
}

/** Splice newText over the oldLength chars at idx, literally. Callers locate once with locateEdit. */
export function applyAt(original: string, idx: number, oldLength: number, newText: string): string {
	return original.slice(0, idx) + newText + original.slice(idx + oldLength);
}

/**
 * Apply an edit_file replacement literally at the located match, and
 * newText is inserted verbatim. (String.prototype.replace with a string
 * pattern expands `$&`, `$'` and friends in the replacement, so the bytes on
 * disk could differ from the bytes the model sent and the gate checked.)
 * Returns null when oldText is not in the file, or when the match is
 * ambiguous (callers ask locateEdit/editRefusal first to say why).
 */
export function applyEdit(
	original: string,
	oldText: string,
	newText: string,
	startLine?: number,
	filePath?: string,
): string | null {
	const t = resolveEdit(original, oldText, newText, startLine, filePath);
	if (t.kind !== "ok") return null;
	return applyAt(original, t.idx, t.oldLength, t.newText);
}

/**
 * The full lines of the edited result that contain the inserted text (or,
 * for a pure deletion, the line the deletion joined). Null when oldText is
 * not in the file or is ambiguous.
 */
export function editedLines(
	original: string,
	oldText: string,
	newText: string,
	startLine?: number,
	filePath?: string,
): string | null {
	const t = resolveEdit(original, oldText, newText, startLine, filePath);
	if (t.kind !== "ok") return null;
	const idx = t.idx;
	newText = t.newText;
	const result = original.slice(0, idx) + newText + original.slice(idx + t.oldLength);
	const start = idx === 0 ? 0 : result.lastIndexOf("\n", idx - 1) + 1;
	const insertEnd = idx + newText.length;
	// If newText ends with a newline, stop there rather than pulling in the
	// untouched line that follows it.
	const endNl = result.indexOf("\n", Math.max(idx, insertEnd - 1));
	return result.slice(start, endNl === -1 ? result.length : endNl);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/**
 * The text a write tool call is about to put on disk, as the write policy
 * should see it. `workingDirectory` resolves a relative edit_file path so the
 * current file can be read; if it cannot be read, or oldText is not in it,
 * the gate falls back to newText (the edit itself will then fail as before).
 */
export function writtenContentFor(
	toolName: string,
	args: Record<string, unknown>,
	workingDirectory: string,
): string | undefined {
	switch (toolName) {
		case "write_file":
		case "write_notes":
			return str(args.content);
		case "edit_file": {
			const newText = str(args.newText) ?? "";
			const oldText = str(args.oldText);
			const p = str(args.path);
			if (oldText !== undefined && p) {
				const abs = path.isAbsolute(p) ? p : path.join(workingDirectory, p);
				try {
					const lines = editedLines(
						fs.readFileSync(abs, "utf-8"),
						oldText,
						newText,
						typeof args.startLine === "number" ? args.startLine : undefined,
						p,
					);
					if (lines !== null) return lines;
				} catch {
					// Missing or unreadable file: check what the model sent.
				}
			}
			return newText;
		}
		case "notebook_edit_cell":
			return str(args.newSource);
		case "notebook_insert_cell":
			return str(args.source);
		default:
			return str(args.content);
	}
}

/**
 * The model-visible blocked result. Says plainly that nothing happened: a
 * small model given only the rule text ignored the block and reported the
 * file as written (Rishi's pilot, 2026-09-29).
 */
export function blockedToolMessage(
	toolName: string,
	isWrite: boolean,
	targetPath: string | undefined,
	reason: string | undefined,
	alternative?: string,
): string {
	const alt = alternative ? ` Alternative: ${alternative}` : "";
	const target = targetPath ? ` ${targetPath}` : "";
	const notDone = isWrite
		? targetPath
			? ` The file${target} was NOT written.`
			: " Nothing was written."
		: " Nothing was changed.";
	return `[TOOLG8 BLOCKED] ${toolName} did NOT run.${notDone} Reason: ${reason}${alt}`;
}

/**
 * Gate a write tool call on the AI SDK path. Returns the blocked message, or
 * null when the write may proceed. write_notes writes to the app's own notes
 * store rather than a workspace file, so only its content is gated (no path,
 * so path and workspace rules do not apply to it).
 */
export function gateWriteTool(
	agentId: string,
	toolName: string,
	args: Record<string, unknown>,
	workingDirectory: string,
): string | null {
	const targetPath = toolName === "write_notes" ? undefined : str(args.path);
	const result = ToolG8.instance().gate(agentId, "write_file", {
		path: targetPath,
		content: writtenContentFor(toolName, args, workingDirectory),
	});
	if (result.allowed) return null;
	return blockedToolMessage(toolName, true, targetPath, result.reason, result.alternative);
}
