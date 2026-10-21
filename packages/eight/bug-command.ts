/**
 * The one entry for `/bug <description>` (TUI) and `8gent bug "<description>"` (CLI).
 *
 * Builds the local report folder with createBugReport (secrets redacted, nothing
 * uploaded) and returns the text to show. No Bun-only APIs: it runs on the Node
 * build (dist/node) too.
 */
import { type BugReportOptions, createBugReport } from "./bug-report.js";

export const BUG_USAGE = 'Usage: /bug <description>   (CLI: 8gent bug "<description>")';
export const BUG_SHARE_LINE = "Share this folder with the team (it has no secrets; check it first)";

export function runBugCommand(
	args: string[],
	opts: BugReportOptions = {},
): { code: number; text: string } {
	const note = args.join(" ").trim();
	if (!note) return { code: 2, text: BUG_USAGE };
	try {
		const dir = createBugReport({ ...opts, note });
		return { code: 0, text: `${dir}\n${BUG_SHARE_LINE}` };
	} catch (e) {
		return {
			code: 1,
			text: `bug: could not write the report (${e instanceof Error ? e.message : String(e)})`,
		};
	}
}
