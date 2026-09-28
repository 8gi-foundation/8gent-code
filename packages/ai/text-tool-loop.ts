/**
 * 8gent AI - Text-Tool Agent Loop
 *
 * Wraps the one-round adapter (runTextToolTurn) in a multi-round agentic loop.
 * On each round it runs one model turn through the injected `call`, executes any
 * tool calls the model emitted against the matching tool implementations, feeds
 * the results back as a follow-up user message, and repeats until the model
 * replies with prose and no further tool calls (or a round cap is reached).
 *
 * A tool that throws never breaks the loop: the error is turned into a short
 * string result and fed back to the model like any other tool output. The only
 * network/I/O the loop performs is whatever the caller's `call` and the tools'
 * `run` functions do; this module itself stays glue-only.
 */

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
	content: string;
	rounds: number;
	toolLog: TextToolLogEntry[];
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

	for (let round = 1; round <= maxRounds; round++) {
		// Stop before starting another round if the caller aborted (turn timeout,
		// circuit breaker, user ESC). Return whatever prose the last round yielded.
		if (opts.signal?.aborted) {
			return { content: lastContent, rounds: round - 1, toolLog };
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
				messages = [
					...messages,
					{ role: "assistant", content: turn.content },
					{ role: "user", content: cutOffNote },
				];
				continue;
			}
		}

		if (turn.toolCalls.length === 0) {
			// Model gave its final answer.
			return { content: turn.content, rounds: round, toolLog };
		}

		// Execute every requested tool and build a single labelled result block.
		const resultParts: string[] = [];
		for (const tc of turn.toolCalls) {
			const result = await executeTool(opts.tools, tc.name, tc.arguments);
			toolLog.push({ name: tc.name, args: tc.arguments, result });
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
					"Use these tool results to answer. If you have enough information,",
					"reply with your final answer as plain prose (no tool_call block).",
				].join("\n"),
			},
		];
	}

	// Round cap hit with the model still calling tools: return the last prose.
	return { content: lastContent, rounds: maxRounds, toolLog };
}
