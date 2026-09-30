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
 * The final answer is then checked against the turn's own tool log
 * (claim-check.ts): commands the user asked to run that never ran, and files the
 * answer says it wrote whose last write was blocked or never happened. Anything
 * contradicted gets ONE follow-up per turn (claimFollowUpMessage) while a round
 * remains; whatever is still contradicted when the turn ends is appended to the
 * answer as a "[harness] Not verified: ..." line and returned in `unverified`.
 * A false completion claim is never passed through silently.
 *
 * A tool that throws never breaks the loop: the error is turned into a short
 * string result and fed back to the model like any other tool output. The only
 * network/I/O the loop performs is whatever the caller's `call` and the tools'
 * `run` functions do; this module itself stays glue-only.
 */

import { checkClaims, claimFollowUpMessage, formatHarnessNote } from "./claim-check";
import { runTextToolTurn, type TextToolMessage } from "./text-tool-client";
import type { ToolSpec } from "./text-tools";

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
	call: (messages: TextToolMessage[]) => Promise<string>;
	maxRounds?: number;
	/**
	 * Optional abort signal. Checked at the top of every round; once aborted the
	 * loop stops and returns the last round's prose. The caller is responsible
	 * for wiring this signal into `call` (so an in-flight model request is torn
	 * down) - this only stops the loop from STARTING another round.
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

/** executeTool's own failures, and tools' conventional error results. */
function isErrorResult(result: string): boolean {
	return /^\s*error\b/i.test(result);
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
		return `Error: no tool named "${name}" is available.`;
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
	const specs = opts.tools.map((t) => t.spec);
	const toolLog: TextToolLogEntry[] = [];

	// Local working copy of the conversation; runTextToolTurn never mutates it,
	// so we own the growth here.
	let messages: TextToolMessage[] = opts.messages.slice();
	let lastContent = "";
	// Did the previous round run at least one tool that did not error?
	let prevRoundHadSuccess = false;
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
	// The user's request this turn: the last user message the caller sent.
	const request = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";
	const claimsAgainstLog = (answer: string) =>
		toolLog.length > 0 ? checkClaims({ request, answer, toolLog }) : [];
	// Every exit goes through here: whatever the log still contradicts is
	// appended as a factual note, never passed through silently.
	const finish = (content: string, rounds: number): TextToolAgentResult => {
		const unfulfilled = claimsAgainstLog(content);
		if (unfulfilled.length === 0) return { content, rounds, toolLog, unverified: [] };
		const note = formatHarnessNote(unfulfilled);
		return {
			content: content.trim() ? `${content.trimEnd()}\n\n${note}` : note,
			rounds,
			toolLog,
			unverified: unfulfilled.map((u) => u.note),
		};
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
		lastContent = turn.content;

		// A reply that stopped inside a tool_call block (output token limit) is
		// neither a final answer nor a runnable call. Tell the model exactly what
		// happened and let it try again in smaller pieces, instead of ending the
		// turn on its partial JSON or a bare "Unterminated string".
		let cutOffNote = "";
		if (turn.cutOffToolCall) {
			cutOffNote = cutOffToolCallMessage(turn.cutOffToolCall.name);
			// No round left to retry in: surface the error as the turn's text.
			if (round === maxRounds) {
				lastContent = [turn.content, cutOffNote].filter(Boolean).join("\n\n");
			}
			if (turn.toolCalls.length === 0) {
				if (round === maxRounds) break;
				// A cut-off call is an attempt at a tool, not an answer to a check.
				awaitingCheckAnswer = false;
				// Nothing ran this round, so the next round no longer directly
				// follows a successful tool round.
				prevRoundHadSuccess = false;
				messages = [
					...messages,
					{ role: "assistant", content: turn.content },
					{ role: "user", content: cutOffNote },
				];
				continue;
			}
		}

		if (turn.toolCalls.length === 0) {
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
			const freshStall = prevRoundHadSuccess && !(checksSent > 0 && hasDoneMarker(turn.content));
			const unansweredCheck = awaitingCheckAnswer && !hasDoneMarker(turn.content);
			if (
				(freshStall || unansweredCheck) &&
				checksWithoutProgress < MAX_CONSECUTIVE_CHECKS &&
				checksSent < MAX_COMPLETION_CHECKS &&
				round < maxRounds &&
				!isQuestionToUser(turn.content)
			) {
				checksSent++;
				checksWithoutProgress++;
				awaitingCheckAnswer = true;
				if (freshStall) preCheckContent = turn.content;
				prevRoundHadSuccess = false;
				messages = [
					...messages,
					{ role: "assistant", content: turn.content },
					{ role: "user", content: COMPLETION_CHECK_MESSAGE },
				];
				continue;
			}
			// Model gave its final answer. Check it against the tool log once; a
			// contradiction gets one follow-up while a round remains. A question
			// to the user is left alone here (finish() still notes it).
			const answer = finalContent(turn.content);
			if (!claimFollowUpSent && round < maxRounds && !isQuestionToUser(turn.content)) {
				const unfulfilled = claimsAgainstLog(answer);
				if (unfulfilled.length > 0) {
					claimFollowUpSent = true;
					awaitingCheckAnswer = false;
					prevRoundHadSuccess = false;
					messages = [
						...messages,
						{ role: "assistant", content: turn.content },
						{ role: "user", content: claimFollowUpMessage(unfulfilled) },
					];
					continue;
				}
			}
			return finish(answer, round);
		}

		// Execute every requested tool and build a single labelled result block.
		const resultParts: string[] = [];
		prevRoundHadSuccess = false;
		// The model resumed tools: a later stall is a fresh one (re-armed).
		awaitingCheckAnswer = false;
		for (const tc of turn.toolCalls) {
			const result = await executeTool(opts.tools, tc.name, tc.arguments);
			toolLog.push({ name: tc.name, args: tc.arguments, result });
			if (!isErrorResult(result)) {
				prevRoundHadSuccess = true;
				// Real tool work: the next stall starts a fresh run of checks.
				checksWithoutProgress = 0;
			}
			// Deterministic guard (Bug B): if the model wrote file contents through
			// the shell instead of write_file, append a short corrective note to
			// this result so the next round is steered back to the right tool.
			const note =
				tc.name === "run_command" && isShellFileWrite(tc.arguments?.command)
					? SHELL_WRITE_NOTE
					: "";
			resultParts.push(`Tool ${tc.name} returned:\n${result}${note}`);
		}

		// Record the model's raw round output, then the tool results as the next
		// user turn, and loop. We feed the raw turn content (prose minus the
		// stripped blocks) as the assistant message; the model still has its own
		// emitted tool_call intent in its head via the result framing below.
		if (cutOffNote) resultParts.push(cutOffNote);
		messages = [
			...messages,
			{ role: "assistant", content: turn.content },
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
