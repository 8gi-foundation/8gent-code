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
	| { kind: "ambiguous"; lines: number[] }
	| { kind: "none-after"; startLine: number; lines: number[] };

/** 1-based line number of a string offset. */
function lineOf(original: string, idx: number): number {
	let n = 1;
	for (let i = original.indexOf("\n"); i !== -1 && i < idx; i = original.indexOf("\n", i + 1)) n++;
	return n;
}

/**
 * Find where oldText goes (#3898). Zero matches: "none". One match: it.
 * Several matches and no startLine: "ambiguous", never a silent first-match.
 * With startLine, the first match that starts at or after that 1-based line
 * wins; if every match is earlier the file is not what the model read, so
 * "none-after" refuses rather than editing the wrong copy.
 */
export function locateEdit(original: string, oldText: string, startLine?: number): EditTarget {
	// indexOf("", i) never returns -1, so an empty oldText would loop forever.
	if (oldText === "") return { kind: "none" };
	const offsets: number[] = [];
	for (let i = original.indexOf(oldText); i !== -1; i = original.indexOf(oldText, i + 1)) {
		offsets.push(i);
	}
	if (offsets.length === 0) return { kind: "none" };
	const lines = offsets.map((o) => lineOf(original, o));
	if (typeof startLine === "number" && Number.isFinite(startLine)) {
		const at = lines.findIndex((l) => l >= startLine);
		return at === -1
			? { kind: "none-after", startLine, lines }
			: { kind: "ok", idx: offsets[at] };
	}
	if (offsets.length > 1) return { kind: "ambiguous", lines };
	return { kind: "ok", idx: offsets[0] };
}

/** Model-visible refusal for a duplicate or stale-anchored edit, or null if the edit can proceed. */
export function editRefusal(target: EditTarget, filePath: string): string | null {
	if (target.kind === "ambiguous") {
		return `Error: oldText matches ${target.lines.length} times in ${filePath} (lines ${target.lines.join(", ")}). Nothing was written. Add surrounding lines to oldText so it is unique, or pass startLine to pick the copy at or after that line.`;
	}
	if (target.kind === "none-after") {
		return `Error: oldText matches in ${filePath} only before line ${target.startLine} (lines ${target.lines.join(", ")}). Nothing was written. The file may have changed since you read it: read_file again and retry.`;
	}
	return null;
}

/**
 * Count refused edits (#3898): one JSON line per refusal in
 * ~/.8gent/edit-ambiguous.jsonl. No file text is logged, only the path,
 * the match lines and the oldText length. Never throws.
 */
export function logEditRefusal(target: EditTarget, filePath: string, oldTextLength: number): void {
	if (target.kind !== "ambiguous" && target.kind !== "none-after") return;
	try {
		const dir = path.join(process.env.HOME || ".", ".8gent");
		fs.mkdirSync(dir, { recursive: true });
		const rec = { ts: new Date().toISOString(), kind: target.kind, path: filePath, lines: target.lines, oldTextLength };
		fs.appendFileSync(path.join(dir, "edit-ambiguous.jsonl"), `${JSON.stringify(rec)}\n`);
	} catch {
		// Logging must never change the edit's outcome.
	}
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
): string | null {
	const t = locateEdit(original, oldText, startLine);
	if (t.kind !== "ok") return null;
	return original.slice(0, t.idx) + newText + original.slice(t.idx + oldText.length);
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
): string | null {
	const t = locateEdit(original, oldText, startLine);
	if (t.kind !== "ok") return null;
	const idx = t.idx;
	const result = original.slice(0, idx) + newText + original.slice(idx + oldText.length);
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
