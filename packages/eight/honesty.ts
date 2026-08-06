/**
 * 8gent - Agentic Honesty gate (Law 1: no fabricated completion).
 *
 * The agent MUST NOT claim an action happened ("created / successful / done /
 * committed") unless a tool actually ran this turn and returned success. This
 * module gates the final response on the turn's tool ledger:
 *
 *   - If the turn made at least one SUCCESSFUL action-tool call, the reply
 *     passes through untouched.
 *   - If every action-tool call FAILED and the reply still claims completion,
 *     the reply is replaced with an honest, actionable failure report built
 *     from the real tool errors.
 *   - If NO action tool ran at all and the reply claims a concrete completed
 *     action (a file/commit that "was created"), the reply is replaced with an
 *     honest "nothing actually ran" note.
 *
 * Pure functions, no I/O - the caller (packages/eight/agent.ts) owns the
 * ledger and applies the gate on both the native tool loop and the text-tool
 * loop. See issue #2747 and the AgenticHonesty skill.
 */

/** One tool call made during the current turn. */
export interface ToolLedgerEntry {
	name: string;
	args?: Record<string, unknown>;
	success: boolean;
	/** Tool output (or error string) - used to build the honest failure report. */
	result?: string;
}

/**
 * Tools whose success a completion claim can legitimately rest on. Read-only
 * tools (read_file, list_files, web_search, ...) never justify "I created X".
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
	"write_file",
	"edit_file",
	"delete_file",
	"run_command",
	"git_add",
	"git_commit",
	"git_push",
	"make_pdf",
	"run_computer_task",
	"desktop_click",
	"desktop_type",
	"desktop_press",
	"desktop_drag",
]);

/**
 * Detect the executor's string-shaped error results (it returns error STRINGS
 * rather than throwing for most failure modes). Mirrors the check in
 * agent.ts's tool wrappers so both paths classify results identically.
 */
export function isErrorToolResult(result: string): boolean {
	return /^(\[[A-Z_ ]*(BLOCKED|DENIED|ERROR)\]|Error:|Error running tool|Unknown tool:|Path blocked by path-guard|Path traversal blocked)/.test(
		result.trimStart(),
	);
}

// A "fileish" object: the artifacts a completion claim is usually about.
const FILEISH =
	String.raw`(?:file|files|folder|directory|dir|repo|repository|branch|commit|document|script|` +
	String.raw`\S+\.(?:txt|md|ts|tsx|js|jsx|py|json|swift|sh|zsh|yml|yaml|toml|html|css|pdf|csv))`;

/**
 * Success-claim detectors. Each pattern requires either explicit success
 * phrasing ("creation successful", "successfully created", "has been
 * created") or an action verb tied to a fileish object ("created the file",
 * "file created at ..."), so ordinary informational prose ("here is how files
 * are created on Unix") does not trip the gate.
 */
const SUCCESS_CLAIM_PATTERNS: RegExp[] = [
	/\b(?:creation|write|update|deletion|removal|commit|push|operation|task) (?:was |is )?successful\b/i,
	/\bsuccessfully (?:created|wrote|written|saved|updated|deleted|removed|committed|pushed|initiated|completed)\b/i,
	/\bhas been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	/\bhave been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	new RegExp(
		String.raw`\b(?:i|we)(?:'ve| have)? (?:just )?(?:created|wrote|written|saved|updated|deleted|committed|pushed)\b[^\n]{0,80}\b${FILEISH}\b`,
		"i",
	),
	new RegExp(
		String.raw`\b${FILEISH} (?:was |is )?(?:created|written|saved) (?:at|in|with|to)\b`,
		"i",
	),
	new RegExp(String.raw`\b(?:created|wrote|saved) (?:the |a |an )?(?:new )?${FILEISH}\b`, "i"),
	new RegExp(
		String.raw`\b${FILEISH}\b[^\n]{0,60}\b(?:created|written|saved|committed|pushed) successfully\b`,
		"i",
	),
];

/** True when the reply claims a concrete completed action. */
export function claimsCompletion(content: string): boolean {
	if (!content) return false;
	return SUCCESS_CLAIM_PATTERNS.some((p) => p.test(content));
}

/** Reply for a success claim made after every action tool FAILED. */
export function buildHonestFailureReply(
	failed: ToolLedgerEntry[],
	workingDirectory?: string,
): string {
	const lines = failed.slice(-5).map((e) => {
		const err = (e.result ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 220);
		const argHint =
			e.args && typeof (e.args as { path?: unknown }).path === "string"
				? ` (path: ${(e.args as { path: string }).path})`
				: "";
		return `- ${e.name}${argHint} failed: ${err}`;
	});
	const sandboxHit = failed.some((e) =>
		/outside working directory|path traversal|path blocked/i.test(e.result ?? ""),
	);
	const sandboxNote =
		sandboxHit && workingDirectory
			? `\n\nI can only write inside ${workingDirectory}. Give me a path inside that directory (or change my working directory) and I will retry for real.`
			: "";
	return `I could not complete that action.\n\n${lines.join("\n")}\n\nNothing was written or changed on disk this turn.${sandboxNote}`;
}

/** Reply for a completion claim made with NO action tool run at all. */
export function buildNoActionReply(): string {
	return (
		"I have not actually done that yet - no tool ran this turn, so nothing changed " +
		"on disk. To do it for real I need to execute the corresponding tool (for " +
		"example write_file). Ask me to proceed and I will run it."
	);
}

export interface HonestyGateResult {
	content: string;
	violated: boolean;
	reason?: string;
}

/**
 * Law 1 gate: given the model's final reply and the turn's tool ledger,
 * return the reply to actually emit. A completion claim is only allowed
 * through when at least one action tool succeeded this turn.
 */
export function enforceAgenticHonesty(opts: {
	content: string;
	ledger: ToolLedgerEntry[];
	workingDirectory?: string;
}): HonestyGateResult {
	const { content, ledger, workingDirectory } = opts;
	const actions = ledger.filter((e) => ACTION_TOOLS.has(e.name));
	if (actions.some((e) => e.success)) {
		return { content, violated: false };
	}
	if (!claimsCompletion(content)) {
		return { content, violated: false };
	}
	const failed = actions.filter((e) => !e.success);
	if (failed.length > 0) {
		return {
			content: buildHonestFailureReply(failed, workingDirectory),
			violated: true,
			reason: `success claim after ${failed.length} failed tool call(s) and zero successes`,
		};
	}
	return {
		content: buildNoActionReply(),
		violated: true,
		reason: "success claim with no action tool call at all",
	};
}
