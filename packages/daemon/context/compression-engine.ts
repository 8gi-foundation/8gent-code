/**
 * CompressionEngine - artifact-preserving incremental summarization.
 *
 * Inputs:  recent message tail, the prior summary (if any), the artifact
 *          registry (rendered verbatim into the prompt).
 * Output:  a new summary that *builds on* the previous one rather than
 *          regenerating it from scratch ("telephone game" mitigation).
 *
 * The strict prompt forbids dropping anything in the registry, and asks
 * the LLM to phrase its summary as a delta over the previous summary so
 * downstream consumers see continuity rather than a series of disjoint
 * snapshots.
 *
 * The LLM call is injected (not imported) so unit tests can run without
 * any provider configured. Production callers pass `generateText` from
 * the AI SDK; tests pass a stub.
 */

import { countMessages, countTokens } from "../../tools/token-counter";
import type { ArtifactRegistryStore } from "./artifact-registry";
import type { CompressionInput, CompressionOutput, Message } from "./types";

export type SummarizerCall = (input: { prompt: string; maxOutputTokens: number }) => Promise<{
	text: string;
}>;

export interface CompressionEngineOptions {
	/** Tokens of the recent tail to keep verbatim after compression. */
	keepRecentTokens?: number;
	/** Hard cap on the LLM-generated summary length. */
	maxSummaryTokens?: number;
}

const DEFAULT_KEEP_RECENT_TOKENS = 4000;
const DEFAULT_MAX_SUMMARY_TOKENS = 1200;

export class CompressionEngine {
	private summarize: SummarizerCall;
	private options: Required<CompressionEngineOptions>;

	constructor(summarize: SummarizerCall, options: CompressionEngineOptions = {}) {
		this.summarize = summarize;
		this.options = {
			keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
			maxSummaryTokens: options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS,
		};
	}

	/**
	 * Run a single compression pass.
	 *
	 * Layout of the returned message array:
	 *   [ original system prompt, summary message, ...recent tail ]
	 *
	 * The summary message is tagged so subsequent compressions can find
	 * and replace it cleanly.
	 */
	async compress(input: CompressionInput): Promise<CompressionOutput> {
		const { messages, previousSummary, registry } = input;
		const keepRecentTokens = input.keepRecentTokens ?? this.options.keepRecentTokens;

		const tokensBefore = countMessages(messages);
		if (messages.length <= 2) {
			return {
				messages,
				summary: previousSummary ?? "",
				tokensBefore,
				tokensAfter: tokensBefore,
				messagesRemoved: 0,
			};
		}

		const systemMsg = messages[0];
		const cutPoint = findCutPoint(messages, keepRecentTokens);
		const toCompress = messages.slice(1, cutPoint);
		const tail = messages.slice(cutPoint);

		if (toCompress.length === 0) {
			return {
				messages,
				summary: previousSummary ?? "",
				tokensBefore,
				tokensAfter: tokensBefore,
				messagesRemoved: 0,
			};
		}

		const renderedRegistry = renderRegistry(registry);
		const prompt = buildCompressionPrompt({
			toCompress,
			previousSummary,
			renderedRegistry,
		});

		const { text: summary } = await this.summarize({
			prompt,
			maxOutputTokens: this.options.maxSummaryTokens,
		});

		const compressed: Message[] = [
			systemMsg,
			{
				role: "system",
				content: `[Compression Checkpoint]\n\n${summary}\n\n${renderedRegistry}`,
			},
			...tail,
		];

		const tokensAfter = countMessages(compressed);
		return {
			messages: compressed,
			summary,
			tokensBefore,
			tokensAfter,
			messagesRemoved: toCompress.length,
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the message array from newest to oldest, accumulating tokens until we
 * hit `keepRecentTokens`. The resulting index is the first message we keep
 * in the recent tail. We then nudge it backward if it would split a
 * tool-call/result pair or a user/assistant turn.
 */
function findCutPoint(messages: Message[], keepRecentTokens: number): number {
	if (messages.length <= 2) return messages.length;

	let accumulated = 0;
	let cut = messages.length;
	for (let i = messages.length - 1; i > 0; i--) {
		accumulated += countTokens(messages[i].content) + 4;
		if (accumulated >= keepRecentTokens) {
			cut = i;
			break;
		}
	}
	if (cut <= 1) return 1;
	if (cut >= messages.length) return messages.length;

	// Don't strand a tool-result without its tool-call.
	if (messages[cut].role === "tool") cut = Math.max(1, cut - 1);
	// Keep user/assistant turn pairs together.
	if (cut > 1 && messages[cut].role === "assistant" && messages[cut - 1]?.role === "user") {
		cut = cut - 1;
	}
	return cut;
}

function renderRegistry(registry: CompressionInput["registry"]): string {
	const lines: string[] = ["## Artifact Registry (preserve verbatim)"];

	const files = Array.from(registry.files.values()).sort((a, b) => a.path.localeCompare(b.path));
	if (files.length > 0) {
		lines.push("### Files");
		for (const f of files) lines.push(`- ${f.path} (${f.lastState})`);
	}

	const entities = Array.from(registry.entities.values()).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	if (entities.length > 0) {
		lines.push("### Entities");
		for (const e of entities) {
			const desc = e.description ? ` - ${e.description}` : "";
			lines.push(`- ${e.name} [${e.type}]${desc}`);
		}
	}

	if (registry.decisions.length > 0) {
		lines.push("### Decisions");
		for (const d of registry.decisions) {
			const rationale = d.rationale ? ` (${d.rationale})` : "";
			lines.push(`- ${d.summary}${rationale}`);
		}
	}

	return lines.join("\n");
}

interface PromptArgs {
	toCompress: Message[];
	previousSummary: string | null;
	renderedRegistry: string;
}

function buildCompressionPrompt(args: PromptArgs): string {
	const serialized = args.toCompress
		.map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
		.join("\n\n");

	const action = args.previousSummary ? "Update" : "Create";
	const previousBlock = args.previousSummary
		? `<previous-summary>\n${args.previousSummary}\n</previous-summary>\n\n`
		: "";

	return [
		`<conversation>\n${serialized}\n</conversation>\n`,
		previousBlock,
		`<registry>\n${args.renderedRegistry}\n</registry>\n`,
		`${action} a structured context checkpoint for another LLM to continue.`,
		"",
		"Rules:",
		"1. Every file path, entity, and decision in <registry> MUST appear in your output verbatim. Do not rename, abbreviate, or drop them.",
		"2. Build on <previous-summary> if present. Treat it as established truth and add new information as a delta. Do not regenerate from scratch.",
		"3. Preserve exact identifiers: function names, error messages, IDs, branch names, command flags.",
		"4. State current task progress: what is done, what is in flight, what is blocked.",
		"",
		"Output format:",
		"## Goal",
		"## Constraints",
		"## Progress (Done / In Progress / Blocked)",
		"## Decisions",
		"## Next Steps",
		"## Context (data, examples, references)",
	].join("\n");
}

export { findCutPoint, renderRegistry, buildCompressionPrompt };

/**
 * Helper: produce a CompressionInput from a registry store + recent state.
 * The store wraps the Map-typed registry that the engine consumes.
 */
export function buildCompressionInput(
	messages: Message[],
	previousSummary: string | null,
	store: ArtifactRegistryStore,
	keepRecentTokens?: number,
): CompressionInput {
	return {
		messages,
		previousSummary,
		registry: store.getRegistry(),
		keepRecentTokens,
	};
}
