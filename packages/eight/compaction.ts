/**
 * Context Compaction Engine
 * LLM-summarized context management for long sessions. When estimated tokens
 * approach the context window limit, older messages are summarized and replaced
 * with a structured checkpoint so the agent can continue indefinitely.
 * @author podjamz
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";

export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	contextWindow: number; // 0 = auto-detect from model
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	contextWindow: 0,
};

export interface CompactionResult {
	summary: string;
	tokensBefore: number;
	tokensAfter: number;
	messagesRemoved: number;
	filesRead: string[];
	filesModified: string[];
}
type Message = { role: string; content: string };

export class FileTracker {
	readonly read = new Set<string>();
	readonly modified = new Set<string>();

	trackRead(path: string) {
		this.read.add(path);
	}
	trackModified(path: string) {
		this.modified.add(path);
	}

	merge(other: FileTracker) {
		Array.from(other.read).forEach((p) => this.read.add(p));
		Array.from(other.modified).forEach((p) => this.modified.add(p));
	}

	getSummary(): string {
		const lines: string[] = ["## Files Touched"];
		if (this.read.size > 0) lines.push("### Read", ...Array.from(this.read).map((f) => `- ${f}`));
		if (this.modified.size > 0)
			lines.push("### Modified", ...Array.from(this.modified).map((f) => `- ${f}`));
		return lines.join("\n");
	}
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: Message[]): number {
	let total = 0;
	for (const m of messages) total += estimateTokens(m.content) + 4;
	return total;
}

// Extract file paths from tool call JSON in message content
const READ_RE = [/read_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi, /cat\s+([^\s;|&]+)/gi];
const WRITE_RE = [
	/write_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi,
	/edit_file[^"]*"(?:file_?path|path)":\s*"([^"]+)"/gi,
];

function extractFiles(messages: Message[]): FileTracker {
	const tracker = new FileTracker();
	for (const m of messages) {
		for (const pat of READ_RE) {
			pat.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = pat.exec(m.content)) !== null) tracker.trackRead(match[1]);
		}
		for (const pat of WRITE_RE) {
			pat.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = pat.exec(m.content)) !== null) tracker.trackModified(match[1]);
		}
	}
	return tracker;
}

const PROMPT_SUFFIX =
	"a structured context checkpoint for another LLM to continue.\nPreserve exact file paths, function names, and error messages.\n\n## Goal        - what the user is trying to accomplish\n## Constraints - requirements and preferences mentioned\n## Progress    - Done [x], In Progress [ ], Blocked\n## Decisions   - key choices with brief rationale\n## Next Steps  - ordered list of what should happen next\n## Context     - data, examples, references needed to continue";

export class CompactionEngine {
	private config: CompactionConfig;
	private fileTracker = new FileTracker();
	private previousSummary: string | null = null;

	constructor(config: Partial<CompactionConfig> = {}) {
		this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
	}

	shouldCompact(messages: Message[], contextWindow?: number): boolean {
		if (!this.config.enabled) return false;
		const cw = contextWindow || this.config.contextWindow || 32768;
		return estimateMessageTokens(messages) > cw - this.config.reserveTokens;
	}

	private findCutPoint(messages: Message[]): number {
		let accumulated = 0;
		let cutIdx = messages.length;
		for (let i = messages.length - 1; i > 0; i--) {
			accumulated += estimateTokens(messages[i].content) + 4;
			if (accumulated >= this.config.keepRecentTokens) {
				cutIdx = i;
				break;
			}
		}
		if (cutIdx <= 1) return 1;
		// Never split tool call/result pairs
		if (messages[cutIdx].role === "tool") cutIdx = Math.max(1, cutIdx - 1);
		// Never split user/assistant turn pairs
		if (
			cutIdx > 1 &&
			messages[cutIdx].role === "assistant" &&
			messages[cutIdx - 1]?.role === "user"
		)
			cutIdx = cutIdx - 1;
		return cutIdx;
	}

	async compact(
		messages: Message[],
		model: LanguageModel,
		contextWindow?: number,
	): Promise<{ messages: Message[]; result: CompactionResult }> {
		const tokensBefore = estimateMessageTokens(messages);
		const cutPoint = this.findCutPoint(messages);
		const systemMsg = messages[0];
		const toSummarize = messages.slice(1, cutPoint);
		const toKeep = messages.slice(cutPoint);

		// Track files from messages about to be discarded
		this.fileTracker.merge(extractFiles(toSummarize));

		const serialized = toSummarize
			.map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
			.join("\n\n");
		const action = this.previousSummary ? "Update" : "Create";
		const prevBlock = this.previousSummary
			? `<previous-summary>\n${this.previousSummary}\n</previous-summary>\n\n`
			: "";
		const prompt = `<conversation>\n${serialized}\n</conversation>\n\n${prevBlock}${action} ${PROMPT_SUFFIX}`;

		const { text: summary } = await generateText({
			model,
			prompt,
			maxOutputTokens: 1500,
		});

		const fullSummary = `${summary}\n\n${this.fileTracker.getSummary()}`;
		this.previousSummary = fullSummary;

		const summaryMsg: Message = {
			role: "system",
			content: `[Context Compaction Summary]\n\n${fullSummary}`,
		};
		const compactedMessages = [systemMsg, summaryMsg, ...toKeep];
		const tokensAfter = estimateMessageTokens(compactedMessages);

		return {
			messages: compactedMessages,
			result: {
				summary: fullSummary,
				tokensBefore,
				tokensAfter,
				messagesRemoved: toSummarize.length,
				filesRead: Array.from(this.fileTracker.read),
				filesModified: Array.from(this.fileTracker.modified),
			},
		};
	}

	getFileTracker(): FileTracker {
		return this.fileTracker;
	}
}

// ===========================================================================
// Proactive Context Compression (Harbor Terminus-2 pattern)
// Issue: #1405
//
// Monitors token usage continuously. When remaining tokens drop below a
// configurable threshold (default 25%), triggers a multi-stage compression
// pipeline. Works with local models (Ollama) — no cloud dependency.
//
// 3-step summarization: summarize history -> key questions -> synthesize
// 4-stage fallback:     unwind -> summarize -> simplify -> nuke-to-system
// ===========================================================================

export type CompressionStage = "none" | "unwind" | "summarize" | "simplify" | "nuke";

export interface ProactiveConfig extends CompactionConfig {
	/** Trigger when remaining tokens fall below this ratio (0-1, default 0.25) */
	threshold: number;
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
	...DEFAULT_COMPACTION_CONFIG,
	threshold: 0.25,
};

export interface ProactiveResult extends CompactionResult {
	stage: CompressionStage;
}

export class ProactiveCompression extends CompactionEngine {
	private proactiveConfig: ProactiveConfig;

	constructor(config: Partial<ProactiveConfig> = {}) {
		const merged = { ...DEFAULT_PROACTIVE_CONFIG, ...config };
		super(merged);
		this.proactiveConfig = merged;
	}

	/** Determine which compression stage is needed based on token pressure. */
	getStage(messages: Message[], contextWindow?: number): CompressionStage {
		const cw = contextWindow || this.proactiveConfig.contextWindow || 32768;
		const used = estimateMessageTokens(messages);
		const ratio = used / cw;

		if (ratio < 1 - this.proactiveConfig.threshold) return "none";
		if (ratio < 0.8) return "unwind";
		if (ratio < 0.9) return "summarize";
		if (ratio < 0.97) return "simplify";
		return "nuke";
	}

	/** Check proactive threshold instead of simple capacity check. */
	override shouldCompact(messages: Message[], contextWindow?: number): boolean {
		if (!this.proactiveConfig.enabled) return false;
		return this.getStage(messages, contextWindow) !== "none";
	}

	/**
	 * Run the appropriate compression stage.
	 *
	 * Stages escalate automatically:
	 *   1. unwind    — drop verbose tool results, keep decisions
	 *   2. summarize — 3-step LLM summarization (Terminus-2 pattern)
	 *   3. simplify  — aggressive single-pass LLM summary
	 *   4. nuke      — discard everything, keep only system prompt + last exchange
	 */
	async compactProactive(
		messages: Message[],
		model: LanguageModel,
		contextWindow?: number,
	): Promise<{ messages: Message[]; result: ProactiveResult }> {
		const stage = this.getStage(messages, contextWindow);
		const tokensBefore = estimateMessageTokens(messages);

		if (stage === "none") {
			return {
				messages,
				result: {
					stage: "none",
					summary: "",
					tokensBefore,
					tokensAfter: tokensBefore,
					messagesRemoved: 0,
					filesRead: [],
					filesModified: [],
				},
			};
		}

		// Stage 1: Unwind — drop tool results from older messages
		if (stage === "unwind") {
			const unwound = this.stageUnwind(messages);
			const tokensAfter = estimateMessageTokens(unwound);
			return {
				messages: unwound,
				result: {
					stage,
					summary: "Unwound verbose tool results",
					tokensBefore,
					tokensAfter,
					messagesRemoved: messages.length - unwound.length,
					filesRead: [],
					filesModified: [],
				},
			};
		}

		// Stage 4: Nuke — no LLM call, just keep system + last exchange
		if (stage === "nuke") {
			const nuked = this.stageNuke(messages);
			const tokensAfter = estimateMessageTokens(nuked);
			return {
				messages: nuked,
				result: {
					stage,
					summary: "Context nuked to system prompt — session history discarded",
					tokensBefore,
					tokensAfter,
					messagesRemoved: messages.length - nuked.length,
					filesRead: Array.from(this.getFileTracker().read),
					filesModified: Array.from(this.getFileTracker().modified),
				},
			};
		}

		// Stage 3: Simplify — aggressive pre-truncation then LLM summary
		if (stage === "simplify") {
			const systemMsg = messages[0];
			const last4 = messages.slice(-4);
			const middle = messages.slice(1, -4);
			const thinned = middle.map((m) => ({
				...m,
				content: m.content.length > 500 ? `${m.content.slice(0, 500)}...[truncated]` : m.content,
			}));
			const simplified = [systemMsg, ...thinned, ...last4];
			const { messages: compacted, result } = await super.compact(simplified, model, contextWindow);
			return {
				messages: compacted,
				result: { ...result, stage },
			};
		}

		// Stage 2: Summarize — 3-step Terminus-2 pattern
		const { messages: compacted, result } = await this.terminus2Compact(
			messages,
			model,
			contextWindow,
		);
		return {
			messages: compacted,
			result: { ...result, stage },
		};
	}

	/**
	 * 3-step Terminus-2 summarization:
	 *   1. Summarize conversation history
	 *   2. Formulate 3 key questions the agent needs answered
	 *   3. Synthesize answers from the summary
	 */
	private async terminus2Compact(
		messages: Message[],
		model: LanguageModel,
		contextWindow?: number,
	): Promise<{ messages: Message[]; result: CompactionResult }> {
		const tokensBefore = estimateMessageTokens(messages);
		const systemMsg = messages[0];
		const recentCount = 8;
		const recent = messages.slice(-recentCount);
		const old = messages.slice(1, -recentCount);

		const serialized = old.map((m) => `[${m.role}]: ${m.content.slice(0, 1500)}`).join("\n\n");

		// Step 1: Summarize
		const { text: historySummary } = await generateText({
			model,
			prompt: `Summarize this conversation into a structured checkpoint.\n\n<conversation>\n${serialized}\n</conversation>\n\nFormat:\n## Goal\n## Progress\n## Key Decisions\n## Files Touched\n## Next Steps`,
			maxOutputTokens: 800,
		});

		// Step 2: Key questions
		const { text: questions } = await generateText({
			model,
			prompt: `Given this summary, what are the 3 most critical questions the agent must answer to continue?\n\n${historySummary}\n\nList exactly 3 questions.`,
			maxOutputTokens: 300,
		});

		// Step 3: Synthesize
		const { text: answers } = await generateText({
			model,
			prompt: `Answer concisely from the session context:\n\n${questions}\n\nContext:\n${historySummary}`,
			maxOutputTokens: 400,
		});

		const fullSummary = `${historySummary}\n\n## Key Questions\n${questions}\n\n## Synthesized Answers\n${answers}`;
		const tracker = this.getFileTracker();

		const summaryMsg: Message = {
			role: "system",
			content: `[Proactive Compression — Terminus-2]\n\n${fullSummary}\n\n${tracker.getSummary()}`,
		};

		const compacted = [systemMsg, summaryMsg, ...recent];
		const tokensAfter = estimateMessageTokens(compacted);

		return {
			messages: compacted,
			result: {
				summary: fullSummary,
				tokensBefore,
				tokensAfter,
				messagesRemoved: old.length,
				filesRead: Array.from(tracker.read),
				filesModified: Array.from(tracker.modified),
			},
		};
	}

	/** Stage 1: Drop tool_result messages from older portion, keep decisions. */
	private stageUnwind(messages: Message[]): Message[] {
		return messages.filter((m, i) => {
			if (i === 0 || i >= messages.length - 10) return true;
			if (m.role === "tool") return false;
			if (m.content.startsWith("[tool_result]")) return false;
			return true;
		});
	}

	/** Stage 4: Keep system prompt + last user/assistant exchange. */
	private stageNuke(messages: Message[]): Message[] {
		const systemMsg = messages[0];
		const lastTwo = messages.slice(-2);
		return [systemMsg, ...lastTwo];
	}
}
