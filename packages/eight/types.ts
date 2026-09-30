/**
 * 8gent Code - Core Types
 *
 * Shared type definitions for the agent harness.
 */

export type MessageContent = string | MessageContentPart[];

export interface MessageContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: { url: string };
}

export interface Message {
	role: "system" | "user" | "assistant" | "tool";
	content: MessageContent;
	toolCalls?: ToolCall[];
	toolCallId?: string;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Event emitted when a tool call starts */
export interface AgentToolStartEvent {
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	stepNumber?: number;
}

/** Event emitted when a tool call finishes */
export interface AgentToolEndEvent {
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	success: boolean;
	durationMs: number;
	stepNumber?: number;
	/** First ~200 chars of the result for display */
	resultPreview?: string;
}

/** Event emitted when a step finishes */
export interface AgentStepEvent {
	stepNumber: number;
	finishReason: string;
	text: string;
	toolCalls: Array<{ toolName: string; toolCallId: string }>;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	/** Wall-clock duration of the LLM call for this step (ms). Excludes the
	 *  preceding tool-execution gap so the figure reflects model speed only. */
	durationMs?: number;
	/** Output tokens per second observed for this step. */
	tokensPerSecond?: number;
}

/** Event emitted when evidence is collected */
export interface AgentEvidenceEvent {
	type: string;
	description: string;
	verified: boolean;
	path?: string;
	command?: string;
}

/** Event emitted with evidence summary at end of response */
export interface AgentEvidenceSummaryEvent {
	total: number;
	verified: number;
	failed: number;
	byType: Record<string, number>;
}

/** Optional callbacks for real-time agent progress */
export interface AgentEventCallbacks {
	onToolStart?: (event: AgentToolStartEvent) => void;
	onToolEnd?: (event: AgentToolEndEvent) => void;
	onStepFinish?: (event: AgentStepEvent) => void;
	onEvidence?: (event: AgentEvidenceEvent) => void;
	onEvidenceSummary?: (event: AgentEvidenceSummaryEvent) => void;
	/**
	 * The turn is being served by a different model from the one asked for:
	 * it is not installed (model-reroute), or it cannot take tools (Law 2).
	 * Fires before config.model self-corrects, so a UI can name the model
	 * that runs the turn while it runs. Display only (#3102).
	 */
	onModelRouted?: (event: { requested: string; used: string; provider: string }) => void;
	onCompaction?: (event: {
		summary: string;
		tokensBefore: number;
		tokensAfter: number;
		messagesRemoved: number;
		filesRead: string[];
		filesModified: string[];
	}) => void;
}

export interface AgentConfig {
	model: string;
	runtime:
		| "ollama"
		| "lmstudio"
		| "llama-server"
		| "openrouter"
		| "anthropic"
		| "apple-foundation"
		| "apfel"
		| "deepseek";
	/** Channel hint for failover routing. "computer" enables the computer-use chain. */
	channel?: "text" | "computer";
	systemPrompt?: string;
	maxTurns?: number;
	workingDirectory?: string;
	apiKey?: string;
	/**
	 * Optional explicit base URL for the LLM endpoint. Threaded through
	 * `createClient()` to the HTTP clients that accept one (ollama, lmstudio,
	 * apfel). Lets one host run several local backends on distinct ports and
	 * pin a specific agent/officer to one of them. Ignored by clients that do
	 * not speak HTTP (apple-foundation spawns a subprocess bridge, not a URL).
	 */
	baseUrl?: string;
	/** Real-time event callbacks for UI integration */
	events?: AgentEventCallbacks;
	/** Load all tools upfront instead of deferred loading (default: false) */
	allTools?: boolean;
	/**
	 * Restricted policy scope this agent gates tool calls under. When set, the
	 * ToolExecutor uses it as the agentId passed to ToolG8.gate(), so any
	 * deny-by-default rules installed for that scope (e.g. "__table__",
	 * "__spawned__") apply to every tool call. Defaults to "primary".
	 */
	agentScope?: string;
	/**
	 * Whether this agent runs unattended (autonomous engine, infinite mode,
	 * heartbeat/improvement loops). When true, destructive tools are gated by the
	 * maker-checker at the tool-execution chokepoint and require an approved
	 * CheckerDecision. Interactive surfaces leave this false. Default: false.
	 */
	unattended?: boolean;
	/**
	 * The workspace role of the TUI tab this agent serves. On the local
	 * text-tool path only "orchestrator" registers the delegation tools
	 * (spawn_agent, check_agent, list_agents); every other role, and no role,
	 * keeps the lean set and is not told about them (#3095).
	 */
	role?: "orchestrator" | "engineer" | "qa";
	/**
	 * Files (or directories) this agent may write and edit, set by spawn_agent's
	 * `allowedPaths`. Writes and edits elsewhere are refused and never run.
	 * Undefined means no limit (#3101).
	 */
	allowedPaths?: string[];
	/**
	 * Whether write_file may open a written deliverable (html, pdf, images,
	 * video, pptx, docx, Marp decks) on macOS. Default true; the agent pool sets
	 * false so spawned sub-agents never open windows (#3107).
	 */
	openOnWrite?: boolean;
}

export interface LLMResponse {
	model: string;
	message: {
		role: string;
		content: string;
		tool_calls?: {
			function: {
				name: string;
				arguments: string;
			};
		}[];
	};
	done: boolean;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_eval_count?: number;
		eval_count?: number;
	};
}

/**
 * Common interface for all LLM clients
 */
export interface LLMClient {
	chat(messages: Message[], tools?: object[]): Promise<LLMResponse>;
	generate(prompt: string): Promise<string>;
	isAvailable(): Promise<boolean>;
}
