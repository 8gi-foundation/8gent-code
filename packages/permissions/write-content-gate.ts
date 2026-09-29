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

/**
 * Apply an edit_file replacement literally: first occurrence only, and
 * newText is inserted verbatim. (String.prototype.replace with a string
 * pattern expands `$&`, `$'` and friends in the replacement, so the bytes on
 * disk could differ from the bytes the model sent and the gate checked.)
 * Returns null when oldText is not in the file.
 */
export function applyEdit(original: string, oldText: string, newText: string): string | null {
	const idx = original.indexOf(oldText);
	if (idx === -1) return null;
	return original.slice(0, idx) + newText + original.slice(idx + oldText.length);
}

/**
 * The full lines of the edited result that contain the inserted text (or,
 * for a pure deletion, the line the deletion joined). Null when oldText is
 * not in the file.
 */
export function editedLines(original: string, oldText: string, newText: string): string | null {
	const idx = original.indexOf(oldText);
	if (idx === -1) return null;
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
					const lines = editedLines(fs.readFileSync(abs, "utf-8"), oldText, newText);
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
