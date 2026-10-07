/**
 * Two write guards for sub-agents (#3101), found in pilot run
 * 2026-09-30_063150 (l4-spawn-parallel-m5): a llama3.2:3b sub-agent told to
 * fix only src/clamp.ts rewrote README.md, then called edit_file on another
 * agent's file with oldText "" and prepended "# twofix" to it.
 *
 * 1. emptyOldTextError: an edit_file whose oldText is empty or only
 *    whitespace has no anchor. indexOf("") is 0, so it used to prepend.
 * 2. editScopeViolation: an agent spawned with `allowedPaths` may write and
 *    edit only those files (or files under those directories). Opt-in: with
 *    no scope, nothing is limited.
 *
 * Pure, no I/O: both return the refusal to show the model, or null.
 */

import * as path from "node:path";

/** The refusal for an edit_file with no anchor, or null when oldText is usable. */
export function emptyOldTextError(oldText: unknown, filePath?: string): string | null {
	if (typeof oldText === "string" && oldText.trim() !== "") return null;
	const where = filePath ? ` on ${filePath}` : "";
	return (
		`Error: edit_file${where} did NOT run. Nothing was changed. oldText is empty, so there is no ` +
		"text to anchor the edit. To replace the whole file, call write_file with the full content. " +
		"To change part of it, call read_file and copy an exact, non-empty snippet into oldText."
	);
}

/** Tools that write into a file named by their `path` argument. */
export const SCOPED_WRITE_TOOLS = new Set<string>([
	"write_file",
	"edit_file",
	"delete_file",
	"notebook_edit_cell",
	"notebook_insert_cell",
	"notebook_delete_cell",
]);

/**
 * Normalise a spawn_agent `allowedPaths` argument: an array of strings, or a
 * comma-separated string. Returns undefined (no scope) when nothing usable was
 * given, so a spawn without it behaves exactly as before.
 */
export function normaliseAllowedPaths(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const paths = raw
		.filter((p): p is string => typeof p === "string")
		.map((p) => p.trim())
		.filter((p) => p !== "");
	return paths.length > 0 ? paths : undefined;
}

/**
 * The refusal for a write outside this agent's scope, or null when the call is
 * not a scoped write, there is no scope, or the target is inside it. A scope
 * entry allows that file, or anything under it when it names a directory.
 */
export function editScopeViolation(
	toolName: string,
	args: Record<string, unknown>,
	workingDirectory: string,
	allowedPaths: readonly string[] | undefined,
): string | null {
	if (!allowedPaths || allowedPaths.length === 0) return null;
	const isDeckTheme = toolName === "deck_theme";
	if (!SCOPED_WRITE_TOOLS.has(toolName) && !isDeckTheme) return null;
	if (isDeckTheme && args.action === "list") return null;
	const scope = allowedPaths.join(", ");
	const target =
		typeof (isDeckTheme ? args.deck : args.path) === "string"
			? String(isDeckTheme ? args.deck : args.path).trim()
			: "";
	// deck_theme writes the deck and a <theme>.css beside it: both must be in scope.
	const targets = [target];
	if (isDeckTheme && target) {
		const themeName =
			args.action === "mix" ? `${String(args.palette)}-x-${String(args.type)}` : String(args.name);
		targets.push(path.join(path.dirname(target), `${themeName}.css`));
	}
	const isInside = (t: string) => {
		const abs = path.resolve(workingDirectory, t);
		return allowedPaths.some((p) => {
			const allowed = path.resolve(workingDirectory, p);
			return abs === allowed || abs.startsWith(`${allowed}${path.sep}`);
		});
	};
	if (target && targets.every(isInside)) return null;
	return (
		`[SCOPE BLOCKED] ${toolName} did NOT run. Nothing was changed. ` +
		`Reason: ${target || "(no path)"} is outside this agent's edit scope (${scope}) ` +
		`Alternative: write or edit only ${scope}; leave every other file to its owner.`
	);
}
