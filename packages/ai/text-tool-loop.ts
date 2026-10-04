/**
 * 8gent AI - Text-Tool Agent Loop
 *
 * Wraps the one-round adapter (runTextToolTurn) in a multi-round agentic loop.
 * On each round it runs one model turn through the injected `call`, executes any
 * tool calls the model emitted against the matching tool implementations, feeds
 * the results back as a follow-up user message, and repeats until the model
 * replies with prose and no further tool calls (or a round cap is reached).
 *
 * The follow-up message tells the model to keep calling tools until every step
 * the user asked for is done: plain prose ends the turn, so prose is reserved
 * for reporting completion or asking the user a genuine question. As a bounded
 * backstop, a no-tool-call reply that follows a successful tool round gets a
 * completion check (COMPLETION_CHECK_MESSAGE): the model either calls the tool
 * for a step it has not done, or confirms with a summary that starts with
 * DONE_MARKER. Once a check is sent, a reply with no tool call ends the turn
 * only if it carries DONE_MARKER or is a question to the user; anything else
 * ("Doing that now.") is checked again. A model that never complies cannot
 * loop: at most MAX_CONSECUTIVE_CHECKS checks in a row may go without a
 * successful tool round between them. Real tool work after a check resets that
 * count, so a long task that stalls, resumes, and stalls again keeps going
 * (Rishi pilot run 2026-09-30_005300 died on its fourth stall when the cap
 * was per turn). MAX_COMPLETION_CHECKS is a generous per-turn ceiling on top,
 * and maxRounds still bounds the turn.
 * The check never reads the reply's wording or punctuation, except for the
 * marker and to leave a question to the user alone.
 *
 * A round where tools ran but every call failed or was refused counts as a
 * stall trigger too (Rishi pilot run 2026-09-30_014230: run_command blocked on
 * /dev/null by the path guard, then on semicolon chaining, then prose). The
 * prose after it gets the check; when the round's refusals include a gate
 * block, the check names the block reasons (blockedCheckMessage). A refused
 * call is never progress, so it does not reset the consecutive count: a model
 * that keeps getting blocked stops at MAX_CONSECUTIVE_CHECKS, and the answer
 * gets a "[harness]" line naming the reasons (blockedStopNote).
 *
 * A degenerate reply (qwen3.8 27B, pilot run 2026-09-30_010512: one line of
 * prose, then "[TOOL_CALL]" 144 times) never reaches the user or the model's
 * own history: the repeated junk is stripped from every reply (see
 * cleanDegenerateReply). A no-tool-call reply that was mostly junk is treated
 * like a stall and gets DEGENERATE_REPLY_MESSAGE, inside the same check budget.
 *
 * The final answer is then checked against the turn's own tool log
 * (claim-check.ts): commands the user asked to run that never ran, and files the
 * answer says it wrote whose last write was blocked or never happened. Anything
 * contradicted gets ONE follow-up per turn (claimFollowUpMessage) while a round
 * remains; whatever is still contradicted when the turn ends is appended to the
 * answer as a "[harness] Not verified: ..." line and returned in `unverified`.
 * A false completion claim is never passed through silently.
 *
 * A final answer that leaves steps of the turn's plan open (pending or in
 * progress in the last update_plan call) gets ONE plan check per turn
 * (planCheckMessage, #3098): report each step's real status or do it, then
 * summarise. The harness never marks a step done on the agent's behalf.
 *
 * One reply can ask for many calls (qwen3.8 27B asked for 144 read_file calls
 * in pilot run 2026-09-30_010512). The loop runs at most MAX_CALLS_PER_ROUND of
 * them; the rest get a short "not run" result asking the model to re-issue the
 * ones it still needs. The abort signal is checked before every call, not only
 * at the top of a round: once the caller aborts (the circuit breaker tripped at
 * 103 calls in that run while the round kept going), the remaining calls are
 * not run, each is logged as "Error: not run: turn aborted", and the turn ends.
 * A skipped call is never dropped silently and never counts as done.
 *
 * A tool that throws never breaks the loop: the error is turned into a short
 * string result and fed back to the model like any other tool output. The only
 * network/I/O the loop performs is whatever the caller's `call` and the tools'
 * `run` functions do; this module itself stays glue-only.
 */

import {
	checkClaims,
	claimFollowUpMessage,
	formatHarnessNote,
	isRefusedToolResult,
} from "./claim-check";
import { runTextToolTurn, type TextToolCall, type TextToolMessage } from "./text-tool-client";
import { type PlanItem, parsePlan } from "./update-plan";
import { runBatchEnabled, type ToolSpec } from "./text-tools";

export type TextTool = {
	spec: ToolSpec;
	run: (args: Record<string, unknown>) => Promise<string>;
};

export type TextToolLogEntry = {
	name: string;
	args: Record<string, unknown>;
	result: string;
};

export interface TextToolAgentOptions {
	messages: TextToolMessage[];
	tools: TextTool[];
	call: TextToolCall;
	maxRounds?: number;
	/**
	 * Optional abort signal. Checked at the top of every round and before every
	 * tool call; once aborted the loop runs no further tools, logs the calls it
	 * skipped as not run, and returns the last round's prose. The caller is
	 * responsible for wiring this signal into `call` (so an in-flight model
	 * request is torn down) and into long-running tools.
	 */
	signal?: AbortSignal;
}

export interface TextToolAgentResult {
	/** The answer to show the user, with any "[harness] Not verified" lines appended. */
	content: string;
	rounds: number;
	toolLog: TextToolLogEntry[];
	/**
	 * Claims the tool log contradicts at the end of the turn, one short line
	 * each (e.g. "'ls deck' was requested but never ran"). Empty when nothing
	 * checkable was contradicted. Recorded in runs.jsonl as `unverified`.
	 */
	unverified: string[];
}

/**
 * Detect a run_command call that is trying to write file CONTENTS through the
 * shell (a redirect to a file, `tee`, or a here-doc), which the model should do
 * with write_file instead. Deterministic string inspection of the actual
 * command - NOT an NLP guess on prose. Used to feed a short corrective note back
 * to the model so it stops substituting shell writes for write_file (Bug B).
 *
 * Plain `mkdir -p some/dir` is intentionally NOT flagged: creating a directory
 * is a legitimate shell action and does not write file contents.
 */
export function isShellFileWrite(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const c = command.trim();
	if (!c) return false;
	// Redirect to a file: `> path` or `>> path` (not `2>&1` style fd dup).
	if (/(^|\s)\d*>>?\s*[^&\s]/.test(c) && !/>>?\s*&/.test(c)) {
		// echo/printf/cat into a redirect is the classic shell-write antipattern.
		if (/\b(echo|printf|cat|tee)\b/.test(c) || />>?\s*['"]?\/?[\w.\-/]+/.test(c)) {
			return true;
		}
	}
	// `... | tee file` writes file contents too.
	if (/\|\s*tee\b/.test(c)) return true;
	// Here-doc redirected into a file: `cat <<EOF > file`.
	if (/<<-?\s*['"]?\w+/.test(c) && />>?\s*[^&\s]/.test(c)) return true;
	return false;
}

const SHELL_WRITE_NOTE =
	"\n\nNote: it looks like you used run_command to write file contents via the " +
	"shell. That is not the correct tool. To create or change a file, call " +
	"write_file (or edit_file) with the path and content. Do not claim the file " +
	"was written unless you call write_file and see its success result.";

/**
 * The message fed back when a reply ended inside an unclosed tool_call block.
 * Structural, not a guess at wording: the parser saw a `tool_call` fence whose
 * JSON object never closed.
 */
export function cutOffToolCallMessage(name: string | null): string {
	const which = name ? `Your ${name} tool_call` : "Your last tool_call";
	return (
		`Error: ${which} was cut off before its JSON closed, most likely because ` +
		"the reply hit the model's output token limit. Nothing was run. If you " +
		"were writing a file, write it in smaller parts: call write_file with the " +
		"first part, then add the rest with edit_file in further calls. Keep each " +
		"tool_call short enough to finish."
	);
}

/**
 * The instruction appended after every round of tool results. The previous
 * wording ("If you have enough information, reply with your final answer as
 * plain prose") invited the model to stop after ANY step of a multi-step task:
 * a local model that had just written deck/outline.md replied "Now let me write
 * the Marp-style deck:" with no tool call, and that ended the turn. Plain prose
 * with no tool_call block always ends the turn, so the instruction says so and
 * reserves prose for the two cases where ending is right.
 */
export const FOLLOW_UP_INSTRUCTION = [
	"If any step the user asked for is not done yet, call the tool for the next",
	"step now: reply with only the tool_call block(s), and do not announce the",
	"step first. A reply with no tool_call block ENDS your turn, so reply with",
	"plain prose only when every step the user asked for is done (say what you",
	"did) or when you must ask the user a question that no tool can answer.",
].join("\n");

/** The explicit marker a model puts at the start of its final summary. */
export const DONE_MARKER = "DONE:";

/**
 * The most completion checks in a row with no successful tool round between
 * them. A check the model answers with real tool work resets the count.
 */
export const MAX_CONSECUTIVE_CHECKS = 2;

/** The most completion checks one turn may receive, however much work ran. */
export const MAX_COMPLETION_CHECKS = 10;

/**
 * Does this reply start with the done marker (plain or in markdown bold)?
 * "DONE." counts too: qwen answered the check that way in pilot run 142559.
 */
export function hasDoneMarker(content: string): boolean {
	return /^\s*\**DONE\**\s*[:.]/.test(content);
}

/** The completion check, sent after a reply with no tool call. */
export const COMPLETION_CHECK_MESSAGE = [
	"Your last reply had no tool_call block, so nothing ran. Check the user's",
	"request against what you have done so far.",
	"- If any step the user asked for is not done yet, call the tool for the next",
	"step now: reply with only the tool_call block(s).",
	"- If every step is done, reply with your final summary of what you did, and",
	`start it with "${DONE_MARKER}".`,
	`Saying you will do a step is not doing it: a reply without a tool_call block`,
	`or "${DONE_MARKER}" gets this check again.`,
].join("\n");

/**
 * Is this no-tool-call reply a question to the user? Structural: its last
 * non-space character is "?". A question is a legitimate reason to end the turn
 * (FOLLOW_UP_INSTRUCTION reserves prose for it), so it is never checked.
 */
export function isQuestionToUser(content: string): boolean {
	return content.trim().endsWith("?");
}

/**
 * Strip a leading DONE_MARKER (tolerating markdown bold around it, e.g.
 * "**DONE:**") so the marker never reaches the user. Content without the
 * marker is returned unchanged.
 */
export function stripDoneMarker(content: string): string {
	const m = /^\s*\**DONE\**\s*:\s*\**\s*/.exec(content);
	return m ? content.slice(m[0].length) : content;
}

/**
 * A line that repeats this many times in a row (blank lines between allowed)
 * is degeneration, not content. Also the removed-line count at which a reply
 * counts as degenerate.
 */
export const DEGENERATE_REPEAT_MIN = 8;

/**
 * A bare placeholder line: a bracket tag like "[TOOL_CALL]" or "[/TOOL_CALL]",
 * or an angle tag like "<tool_call>" or "</tool_call>", alone on its line. It
 * carries no content for the user; the call itself, if any, has already been
 * parsed out of the reply.
 */
const PLACEHOLDER_LINE = /^(?:\[\/?[A-Z][A-Z0-9_ ]*\]|<\/?[a-z][a-z0-9_]*\s*\/?>)$/;

export interface DegenerateCheck {
	/** The reply with placeholder lines and repeated runs removed. */
	clean: string;
	/**
	 * Was the reply degenerate: a repeated run was found, DEGENERATE_REPEAT_MIN
	 * or more placeholder lines were removed, or nothing but junk was left?
	 */
	degenerate: boolean;
}

/**
 * Strip repetition degeneration from a reply, structurally: bare placeholder
 * lines, and every repeat after the first in a run of DEGENERATE_REPEAT_MIN
 * or more identical lines. Markdown table rows ("| ... |") are never treated
 * as a repeated run, so a table with repeated values is left alone. A reply
 * with nothing to strip is returned unchanged.
 */
export function cleanDegenerateReply(content: string): DegenerateCheck {
	const lines = content.split("\n");
	const drop = new Array<boolean>(lines.length).fill(false);
	let placeholders = 0;
	for (let i = 0; i < lines.length; i++) {
		if (PLACEHOLDER_LINE.test(lines[i].trim())) {
			drop[i] = true;
			placeholders++;
		}
	}
	let repeatedRun = false;
	// Runs of identical non-blank lines, ignoring blank lines between them.
	let i = 0;
	while (i < lines.length) {
		const text = lines[i].trim();
		if (text === "" || drop[i] || text.startsWith("|")) {
			i++;
			continue;
		}
		const members = [i];
		let j = i + 1;
		while (j < lines.length) {
			const t = lines[j].trim();
			if (t === "") {
				j++;
				continue;
			}
			if (t !== text) break;
			members.push(j);
			j++;
		}
		if (members.length >= DEGENERATE_REPEAT_MIN) {
			repeatedRun = true;
			for (const m of members.slice(1)) drop[m] = true;
		}
		i = members[members.length - 1] + 1;
	}
	if (!drop.includes(true)) return { clean: content, degenerate: false };
	const clean = lines
		.filter((_, k) => !drop[k])
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		clean,
		degenerate: repeatedRun || placeholders >= DEGENERATE_REPEAT_MIN || clean === "",
	};
}

/** Sent after a no-tool-call reply that was mostly repeated junk. */
export const DEGENERATE_REPLY_MESSAGE = [
	"Your last reply repeated a placeholder and no tool ran.",
	"Either call the next tool now (reply with only the tool_call block), or give",
	`your final summary of what you did, starting with "${DONE_MARKER}".`,
].join("\n");

/**
 * The most tool calls one reply may run. Calls past it are not run and the
 * model is asked to re-issue the ones it still needs, a few at a time.
 * Well under the agent's per-turn circuit breaker limit (50), so one reply can
 * no longer spend the whole turn's budget by itself.
 */
export const MAX_CALLS_PER_ROUND = 25;

/**
 * The result logged for a call skipped because the turn was aborted. Starts
 * with "Error" so the claim check and the success bookkeeping never count it
 * as done.
 */
export function abortedCallResult(signal: AbortSignal | undefined): string {
	const reason = abortReasonText(signal?.reason);
	return reason ? `Error: not run: turn aborted (${reason}).` : "Error: not run: turn aborted.";
}

/**
 * A short, human reason from AbortSignal.reason, or "" when there is none
 * worth showing (abort() with no argument yields a generic AbortError).
 */
function abortReasonText(reason: unknown): string {
	if (reason === undefined || reason === null) return "";
	if (typeof reason === "string") return reason.trim();
	if (reason instanceof Error) {
		if (reason.name === "AbortError") return "";
		return reason.message.trim();
	}
	return "";
}

/** The result logged for a call past MAX_CALLS_PER_ROUND. */
export function overCapCallResult(requested: number): string {
	return (
		`Error: not run: too many tool calls in one reply (${requested} requested, ` +
		`limit ${MAX_CALLS_PER_ROUND}). The first ${MAX_CALLS_PER_ROUND} ran. ` +
		"Re-issue the calls you still need, a few at a time."
	);
}

/**
 * Tools whose failure stops the rest of a reply under the batch trial
 * (EIGHT_RUN_BATCH=1, #3502). A failed read changes nothing, so the calls after
 * it still run.
 */
const BATCH_STOP_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "run_command"]);

/**
 * True when a write, edit or command call failed: refused or errored (the same
 * test the claim check uses), or a command that ran and exited non-zero
 * ("Exit code 1:"), since later calls in the reply were planned on its success.
 */
export function isFailedChangeCall(name: string, result: string): boolean {
	if (!BATCH_STOP_TOOLS.has(name)) return false;
	if (isRefusedToolResult(result)) return true;
	return name === "run_command" && /^Exit code (?!0:)[^:\n]*:/.test(result);
}

/**
 * The result logged for a call skipped because an earlier write, edit or
 * command in the same reply failed (batch trial only). Starts with "Error" so
 * the claim check and the success bookkeeping never count it as done.
 */
export function batchSkippedCallResult(failedIndex: number, failedName: string): string {
	return (
		`Error: not run: call ${failedIndex + 1} (${failedName}) in this reply failed, ` +
		"so the calls after it were skipped. Read its result, then re-issue the calls you still need."
	);
}

/**
 * The short reason a gate gave for blocking a call, or null when the result is
 * not a gate block ("[TOOLG8 BLOCKED] ... Reason: X Alternative: ...",
 * "[BLOCKED] X. Use ... Command: ..."). Structural: reads the gate's own
 * prefix and fields, never the model's prose.
 */
export function blockReason(result: string): string | null {
	const m = /^\s*\[[^\]\n]*\bBLOCKED\b[^\]\n]*\]\s*([\s\S]*)$/i.exec(result);
	if (!m) return null;
	const body = m[1].trim();
	const field = /\bReason:\s*([\s\S]*?)(?:\s+Alternative:[\s\S]*)?$/.exec(body);
	let reason = field ? field[1] : body.split(/\s+Command:/)[0];
	if (!field) reason = reason.split(/\.(?:\s|$)/)[0];
	reason = reason.replace(/\s+/g, " ").replace(/\.$/, "").trim();
	if (reason.length > 120) reason = `${reason.slice(0, 117)}...`;
	return reason || "blocked";
}

/** The completion check sent after prose that follows an all-blocked round. */
export function blockedCheckMessage(reasons: string[]): string {
	return [
		`Your last tool calls were blocked (${reasons.join("; ")}), so they did not run.`,
		"Use a different approach (one command per run_command call, no chaining)",
		`and continue: reply with only the tool_call block(s). Or, if every step is`,
		`done, reply with your final summary starting with "${DONE_MARKER}".`,
	].join("\n");
}

/** Appended when a turn stalls after blocked calls and the check budget is spent. */
export function blockedStopNote(reasons: string[]): string {
	return (
		`[harness] Stopped: tool calls kept being blocked (${reasons.join("; ")}) ` +
		"and the model neither found another way nor confirmed it was done."
	);
}

/**
 * The result for a call to a tool that is not registered this turn. Names the
 * tools that are, so the model can pick one or say it cannot do the step
 * (#3091: qwen3.8 kept calling spawn_agent, which the local tool set lacks).
 * Starts with "Error" so it is never counted as progress.
 */
export function unknownToolResult(name: string, available: string[]): string {
	const list = available.length > 0 ? available.join(", ") : "none";
	return `Error: no tool named "${name}" is available. Available tools: ${list}.`;
}

/**
 * The `unverified` line for a turn that ran tools and then ended with no
 * answer at all (#3091: "" recorded as status ok, the TUI showed "No reply.").
 */
export function emptyReplyStall(toolCalls: number): string {
	const calls = toolCalls === 1 ? "1 tool call" : `${toolCalls} tool calls`;
	return `the model ended the turn without an answer after ${calls}, so the task may be unfinished`;
}

/** The answer shown in place of an empty reply after tool work. */
export function emptyReplyNote(toolCalls: number): string {
	return `[harness] No reply: ${emptyReplyStall(toolCalls)}.`;
}

/**
 * The plan steps still open when the turn ends (#3098): pending or in
 * progress in the turn's last successful update_plan call. Failed steps are
 * an honest report, so they are not open. No update_plan call, or none that
 * parsed, means there is no plan to hold the answer to: empty.
 */
export function openPlanSteps(toolLog: ReadonlyArray<TextToolLogEntry>): PlanItem[] {
	for (let i = toolLog.length - 1; i >= 0; i--) {
		const entry = toolLog[i];
		if (entry.name !== "update_plan" || isRefusedToolResult(entry.result)) continue;
		const parsed = parsePlan(entry.args.plan);
		if (!parsed.ok) continue;
		return parsed.items.filter((s) => s.status === "pending" || s.status === "in_progress");
	}
	return [];
}

/**
 * The plan check, sent once per turn when the final answer leaves plan steps
 * open (#3098, pilot run 2026-09-30_062747: 7 update_plan calls, the last one
 * left step 8 of 8 in progress). The harness never ticks a step itself: the
 * person reads this plan, so only the agent may say a step is done.
 */
export function planCheckMessage(open: ReadonlyArray<PlanItem>): string {
	const lines = open.map((s) => `- ${s.step} (${s.status})`);
	return [
		"Your plan still has steps that are not marked done:",
		...lines,
		"The user sees this plan. If these steps are finished, call update_plan now",
		"with every step and its real status. If a step is not finished, do it now,",
		"or mark it failed if it cannot be done. Then reply with your final summary,",
		`starting with "${DONE_MARKER}".`,
	].join("\n");
}

/**
 * Run a tool-call against the matching tool, never throwing. A missing tool or a
 * throwing `run` is captured as a short error string so the loop can feed it
 * back to the model instead of aborting.
 */
async function executeTool(
	tools: TextTool[],
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const tool = tools.find((t) => t.spec.name === name);
	if (!tool) {
		return unknownToolResult(name, tools.map((t) => t.spec.name));
	}
	try {
		return await tool.run(args);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return `Error running tool "${name}": ${msg}`;
	}
}

/**
 * Run the text-tool agent loop.
 *
 * Each round runs one `runTextToolTurn`. When the model emits tool calls, every
 * call is executed and its result is appended to a single follow-up user message
 * (clearly labelled per tool), the model's raw round content is recorded as an
 * assistant message, and the loop continues. When the model emits no tool calls,
 * its prose is returned. If `maxRounds` rounds elapse with the model still
 * asking for tools, the loop stops and returns the last round's prose content
 * (which may be empty if the final round was tool-calls only).
 */
export async function runTextToolAgent(
	opts: TextToolAgentOptions,
): Promise<TextToolAgentResult> {
	const maxRounds = opts.maxRounds ?? 6;
	// Off-by-default trial (#3502), read once per turn.
	const batchTrial = runBatchEnabled();
	const specs = opts.tools.map((t) => t.spec);
	const toolLog: TextToolLogEntry[] = [];

	// Local working copy of the conversation; runTextToolTurn never mutates it,
	// so we own the growth here.
	let messages: TextToolMessage[] = opts.messages.slice();
	let lastContent = "";
	// Did the previous round run at least one tool that did not error?
	let prevRoundHadSuccess = false;
	// Did the previous round run tools that ALL failed or were refused?
	let prevRoundAllRefused = false;
	// Gate block reasons from the previous round, and since the last round
	// that ran a tool successfully (deduped, in order).
	let prevRoundBlockReasons: string[] = [];
	let blockReasonsSinceProgress: string[] = [];
	// Set when a stall after blocked calls ends the turn unchecked.
	let stoppedOnBlocks = false;
	// Completion checks sent this turn (capped at MAX_COMPLETION_CHECKS).
	let checksSent = 0;
	// Checks sent since the last round that ran a tool successfully (capped at
	// MAX_CONSECUTIVE_CHECKS). Progress, not the check count, keeps a turn alive.
	let checksWithoutProgress = 0;
	// Was the last message we sent a completion check the model has not yet
	// answered with a tool call? Then prose without DONE_MARKER is not final.
	let awaitingCheckAnswer = false;
	// The reply the check was sent after: the summary to fall back on when the
	// model answers the check with a bare marker ("DONE:") and nothing else.
	let preCheckContent = "";
	const finalContent = (content: string): string => {
		const stripped = stripDoneMarker(content);
		if (stripped.trim() === "" && content.trim() !== "" && preCheckContent.trim() !== "") {
			return preCheckContent;
		}
		return stripped;
	};
	// The claim check's follow-up fires at most once per turn.
	let claimFollowUpSent = false;
	// The plan check (#3098) fires at most once per turn.
	let planCheckSent = false;
	// The user's request this turn: the last user message the caller sent.
	const request = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";
	const claimsAgainstLog = (answer: string) =>
		toolLog.length > 0 ? checkClaims({ request, answer, toolLog }) : [];
	// Every exit goes through here: whatever the log still contradicts is
	// appended as a factual note, never passed through silently.
	const finish = (raw: string, rounds: number): TextToolAgentResult => {
		// Repeated junk never reaches the user, whichever exit this is.
		const content = cleanDegenerateReply(raw).clean;
		// No answer after tool work is not a finished turn (#3091): say so in
		// the answer and in `unverified`, whichever exit this is.
		const empty = content.trim() === "" && toolLog.length > 0;
		const unfulfilled = claimsAgainstLog(content);
		const unverified = [
			...(empty ? [emptyReplyStall(toolLog.length)] : []),
			...unfulfilled.map((u) => u.note),
		];
		if (unverified.length === 0) return { content, rounds, toolLog, unverified: [] };
		const notes = [
			empty ? emptyReplyNote(toolLog.length) : content.trimEnd(),
			unfulfilled.length > 0 ? formatHarnessNote(unfulfilled) : "",
		].filter((n) => n.trim() !== "");
		return { content: notes.join("\n\n"), rounds, toolLog, unverified };
	};

	for (let round = 1; round <= maxRounds; round++) {
		// Stop before starting another round if the caller aborted (turn timeout,
		// circuit breaker, user ESC). Return whatever prose the last round yielded.
		if (opts.signal?.aborted) {
			return finish(finalContent(lastContent), round - 1);
		}
		const turn = await runTextToolTurn({
			messages,
			tools: specs,
			call: opts.call,
		});
		// Strip repetition degeneration before the reply is judged, fed back to
		// the model as its own history, or kept as the turn's last prose, which
		// the abort exit returns.
		const degen = cleanDegenerateReply(turn.content);
		const replyText = degen.clean;
		lastContent = replyText;

		// A reply that stopped inside a tool_call block (output token limit) is
		// neither a final answer nor a runnable call. Tell the model exactly what
		// happened and let it try again in smaller pieces, instead of ending the
		// turn on its partial JSON or a bare "Unterminated string".
		let cutOffNote = "";
		if (turn.cutOffToolCall) {
			cutOffNote = cutOffToolCallMessage(turn.cutOffToolCall.name);
			// No round left to retry in: surface the error as the turn's text.
			if (round === maxRounds) {
				lastContent = [replyText, cutOffNote].filter(Boolean).join("\n\n");
			}
			if (turn.toolCalls.length === 0) {
				if (round === maxRounds) break;
				// A cut-off call is an attempt at a tool, not an answer to a check.
				awaitingCheckAnswer = false;
				// Nothing ran this round, so the next round no longer directly
				// follows a successful tool round.
				prevRoundHadSuccess = false;
				prevRoundAllRefused = false;
				messages = [
					...messages,
					{ role: "assistant", content: replyText },
					{ role: "user", content: cutOffNote },
				];
				continue;
			}
		}

		if (turn.toolCalls.length === 0) {
			// A reply that was mostly repeated junk is a stall whatever came
			// before it: ask once more for a tool call or a DONE summary, inside
			// the same budget as the completion check.
			if (
				degen.degenerate &&
				!hasDoneMarker(replyText) &&
				!isQuestionToUser(replyText) &&
				checksWithoutProgress < MAX_CONSECUTIVE_CHECKS &&
				checksSent < MAX_COMPLETION_CHECKS &&
				round < maxRounds
			) {
				checksSent++;
				checksWithoutProgress++;
				awaitingCheckAnswer = true;
				prevRoundHadSuccess = false;
				prevRoundAllRefused = false;
				messages = [
					...messages,
					{ role: "assistant", content: replyText },
					{ role: "user", content: DEGENERATE_REPLY_MESSAGE },
				];
				continue;
			}
			// Bounded completion check: straight after a successful tool round, a
			// reply with no tool call may be a real summary or a step the model
			// announced and never took ("Now creating the Marp deck from the
			// outline."). Its wording and punctuation cannot tell those apart, so
			// ask the model while a round remains. After a check, only a reply
			// carrying DONE_MARKER (or a question to the user) is final; more
			// prose ("Doing that now.") is checked again, up to the caps: two in
			// a row without tool work between them, ten in the whole turn.
			// Once the model has been told the protocol this turn, a DONE-marked
			// reply after later tool rounds is taken at its word.
			// A round whose tools all failed or were blocked is a stall trigger
			// too (run 014230): the prose after it is not a final answer either.
			// An empty reply after tool work is a stall too, whatever the round
			// before it was (#3091): it is never the turn's answer.
			const emptyAfterWork = replyText.trim() === "" && toolLog.length > 0;
			const freshStall =
				(prevRoundHadSuccess || prevRoundAllRefused || emptyAfterWork) &&
				!((checksSent > 0 || planCheckSent) && hasDoneMarker(replyText));
			const unansweredCheck = awaitingCheckAnswer && !hasDoneMarker(replyText);
			const stalled = (freshStall || unansweredCheck) && !isQuestionToUser(replyText);
			if (
				stalled &&
				checksWithoutProgress < MAX_CONSECUTIVE_CHECKS &&
				checksSent < MAX_COMPLETION_CHECKS &&
				round < maxRounds
			) {
				const checkMessage =
					freshStall && prevRoundAllRefused && prevRoundBlockReasons.length > 0
						? blockedCheckMessage(prevRoundBlockReasons)
						: COMPLETION_CHECK_MESSAGE;
				checksSent++;
				checksWithoutProgress++;
				awaitingCheckAnswer = true;
				if (freshStall && replyText.trim() !== "") preCheckContent = replyText;
				prevRoundHadSuccess = false;
				prevRoundAllRefused = false;
				messages = [
					...messages,
					{ role: "assistant", content: replyText },
					{ role: "user", content: checkMessage },
				];
				continue;
			}
			// A stall the budget no longer lets us check, with blocks since the
			// last real progress: say so in the answer, never end silently.
			if (stalled && blockReasonsSinceProgress.length > 0) stoppedOnBlocks = true;
			// Model gave its final answer. Check it against the tool log once; a
			// contradiction gets one follow-up while a round remains. A question
			// to the user is left alone here (finish() still notes it).
			const answer = finalContent(replyText);
			// The answer leaves plan steps open: ask once for their real status
			// (#3098). A question to the user pauses the plan, so it is left
			// alone, and so is a turn that ended on a stall it could not check.
			if (!planCheckSent && !stalled && round < maxRounds && !isQuestionToUser(replyText)) {
				const open = openPlanSteps(toolLog);
				if (open.length > 0) {
					planCheckSent = true;
					awaitingCheckAnswer = false;
					prevRoundHadSuccess = false;
					prevRoundAllRefused = false;
					if (answer.trim() !== "") preCheckContent = answer;
					messages = [
						...messages,
						{ role: "assistant", content: replyText },
						{ role: "user", content: planCheckMessage(open) },
					];
					continue;
				}
			}
			if (!claimFollowUpSent && round < maxRounds && !isQuestionToUser(replyText)) {
				const unfulfilled = claimsAgainstLog(answer);
				if (unfulfilled.length > 0) {
					claimFollowUpSent = true;
					awaitingCheckAnswer = false;
					prevRoundHadSuccess = false;
					prevRoundAllRefused = false;
					messages = [
						...messages,
						{ role: "assistant", content: replyText },
						{ role: "user", content: claimFollowUpMessage(unfulfilled) },
					];
					continue;
				}
			}
			const noted = stoppedOnBlocks
				? [answer.trimEnd(), blockedStopNote(blockReasonsSinceProgress)].filter(Boolean).join("\n\n")
				: answer;
			return finish(noted, round);
		}

		// Execute every requested tool and build a single labelled result block.
		const resultParts: string[] = [];
		prevRoundHadSuccess = false;
		prevRoundBlockReasons = [];
		let ranAny = false;
		// The model resumed tools: a later stall is a fresh one (re-armed).
		awaitingCheckAnswer = false;
		const calls = turn.toolCalls;
		let abortedAt = -1;
		// Batch trial (#3502): index of the first failed write, edit or command
		// in this reply; the calls after it are logged as not run.
		let failedChangeAt = -1;
		for (let k = 0; k < calls.length; k++) {
			const tc = calls[k];
			// The caller can abort mid-round (circuit breaker, turn timeout, ESC):
			// stop before the next call instead of running the rest of the reply.
			if (opts.signal?.aborted) {
				abortedAt = k;
				break;
			}
			if (failedChangeAt >= 0) {
				// Log each skipped call, and tell the model once in the result block.
				const result = batchSkippedCallResult(failedChangeAt, calls[failedChangeAt].name);
				toolLog.push({ name: tc.name, args: tc.arguments, result });
				if (k === failedChangeAt + 1) {
					resultParts.push(
						`Calls ${k + 1}-${calls.length} (${calls.length - k}) were not run:\n${result}`,
					);
				}
				continue;
			}
			if (k >= MAX_CALLS_PER_ROUND) {
				// Over the per-reply cap: log each skipped call, and tell the model
				// once (not once per call) in the result block.
				const result = overCapCallResult(calls.length);
				toolLog.push({ name: tc.name, args: tc.arguments, result });
				if (k === MAX_CALLS_PER_ROUND) {
					resultParts.push(
						`Calls ${MAX_CALLS_PER_ROUND + 1}-${calls.length} (${calls.length - MAX_CALLS_PER_ROUND}) were not run:\n${result}`,
					);
				}
				continue;
			}
			const result = await executeTool(opts.tools, tc.name, tc.arguments);
			toolLog.push({ name: tc.name, args: tc.arguments, result });
			ranAny = true;
			// A gate block ("[TOOLG8 BLOCKED]", "[BLOCKED]") is a refusal, not
			// progress, exactly like an "Error..." result.
			if (!isRefusedToolResult(result)) {
				prevRoundHadSuccess = true;
				// Real tool work: the next stall starts a fresh run of checks.
				checksWithoutProgress = 0;
				blockReasonsSinceProgress = [];
				stoppedOnBlocks = false;
			} else {
				const reason = blockReason(result);
				if (reason !== null) {
					if (!prevRoundBlockReasons.includes(reason)) prevRoundBlockReasons.push(reason);
					if (!blockReasonsSinceProgress.includes(reason)) blockReasonsSinceProgress.push(reason);
				}
			}
			// Deterministic guard (Bug B): if the model wrote file contents through
			// the shell instead of write_file, append a short corrective note to
			// this result so the next round is steered back to the right tool.
			const note =
				tc.name === "run_command" && isShellFileWrite(tc.arguments?.command)
					? SHELL_WRITE_NOTE
					: "";
			resultParts.push(`Tool ${tc.name} returned:\n${result}${note}`);
			if (batchTrial && isFailedChangeCall(tc.name, result)) failedChangeAt = k;
		}

		prevRoundAllRefused = ranAny && !prevRoundHadSuccess;
		if (prevRoundHadSuccess) prevRoundBlockReasons = [];

		if (abortedAt >= 0) {
			// Aborted mid-round: every call not reached is logged as not run,
			// then the turn ends here. No further model round is started.
			const result = abortedCallResult(opts.signal);
			for (const tc of calls.slice(abortedAt)) {
				toolLog.push({ name: tc.name, args: tc.arguments, result });
			}
			return finish(finalContent(lastContent), round);
		}

		// Record the model's raw round output, then the tool results as the next
		// user turn, and loop. We feed the raw turn content (prose minus the
		// stripped blocks) as the assistant message; the model still has its own
		// emitted tool_call intent in its head via the result framing below.
		if (cutOffNote) resultParts.push(cutOffNote);
		messages = [
			...messages,
			{ role: "assistant", content: replyText },
			{
				role: "user",
				content: [
					...resultParts,
					"",
					FOLLOW_UP_INSTRUCTION,
				].join("\n"),
			},
		];
	}

	// Round cap hit with the model still calling tools: return the last prose.
	return finish(finalContent(lastContent), maxRounds);
}
