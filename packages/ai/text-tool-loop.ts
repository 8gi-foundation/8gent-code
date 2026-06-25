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
}

export interface TextToolAgentResult {
	content: string;
	rounds: number;
	toolLog: TextToolLogEntry[];
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
		const turn = await runTextToolTurn({
			messages,
			tools: specs,
			call: opts.call,
		});
		lastContent = turn.content;

		if (turn.toolCalls.length === 0) {
			// Model gave its final answer.
			return { content: turn.content, rounds: round, toolLog };
		}

		// Execute every requested tool and build a single labelled result block.
		const resultParts: string[] = [];
		for (const tc of turn.toolCalls) {
			const result = await executeTool(opts.tools, tc.name, tc.arguments);
			toolLog.push({ name: tc.name, args: tc.arguments, result });
			resultParts.push(`Tool ${tc.name} returned:\n${result}`);
		}

		// Record the model's raw round output, then the tool results as the next
		// user turn, and loop. We feed the raw turn content (prose minus the
		// stripped blocks) as the assistant message; the model still has its own
		// emitted tool_call intent in its head via the result framing below.
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
