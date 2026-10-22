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

/** Event emitted just before a model call. Names only: never prompt text, args or output. */
export interface AgentStepStartEvent {
	stepNumber: number;
	provider: string;
	model: string;
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
	onStepStart?: (event: AgentStepStartEvent) => void;
	onStepFinish?: (event: AgentStepEvent) => void;
	onEvidence?: (event: AgentEvidenceEvent) => void;
	onEvidenceSummary?: (event: AgentEvidenceSummaryEvent) => void;
	/**
	 * The turn is being served by a different model from the one asked for:
	 * it is not installed (model-reroute), or it cannot take tools (Law 2).
	 * Fires before config.model self-corrects, so a UI can name the model
	 * that runs the turn while it runs. Display only (#3102).
	 */
	onModelRouted?: (event: {
		requested: string;
		used: string;
		provider: string;
		/** Why: "capability" (cannot call tools), "missing" (not installed); absent = did not answer. */
		reason?: "capability" | "missing";
	}) => void;
	/** A steering message (Agent.steer) was delivered into the running turn (D1). */
	onSteer?: (event: { text: string }) => void;
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
		| "deepseek"
		// Any hosted registry provider (minimax, groq, ...): endpoint and key come from its registry entry (#4622).
		| (string & {});
	/** Channel hint for failover routing. "computer" enables the computer-use chain. */
	channel?: "text" | "computer";
	/**
	 * The user named this provider explicitly (a `--provider` flag, or a host
	 * config that pins it) (#3746). A provider error then ends the turn with a
	 * plain message instead of moving to another provider: the failover chain,
	 * the hedge sibling and the tool-capability reroute all stay on this
	 * provider. Unset: the adaptive router, as before.
	 */
	providerPinned?: boolean;
	/**
	 * Load one-file extensions from ~/.8gent/extensions (G1). Off by default:
	 * the interactive TUI and the headless CLI opt in; daemon, Table and
	 * no-tool sessions never load them.
	 */
	extensions?: boolean;
	/**
	 * A person is at the keyboard. Unset: decided from the terminal (stdin and
	 * stdout are TTYs and the session is not unattended). Unattended sessions
	 * need approval before an extension tool runs, so it is refused there.
	 */
	attended?: boolean;
	/** Where extensions load from when enabled. Default ~/.8gent/extensions (os.homedir()). */
	extensionsDir?: string;
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
	 * TTS voice of the TUI tab this 8gent serves (tabVoices.assign in tools/speak.ts),
	 * used when the model gives `speak` no voice. Must be a SPEAK_VOICES name;
	 * speak() rejects any other. Unset: Daniel.
	 */
	tabVoice?: string;
	/**
	 * Headless output (#3638): when the text tool loop's completion check is
	 * answered with "DONE:", keep the model's reply before the check in front
	 * of the summary. Set by `8gent run` (packages/eight/run.ts), whose final
	 * text is read by programs; the TUI leaves it off so a person does not
	 * read the same summary twice. See TextToolAgentOptions.keepAnswerFirst.
	 */
	keepAnswerFirst?: boolean;
	/** Done gate (#4505): refuse a tests-pass claim without a newer passing test run. Default off; EIGHT_TEST_CLAIM_GATE=1 also enables; the option wins. */
	testClaimGate?: boolean;
	/** Required-output gate (#4734): a turn may not end while an output path the ask names is missing. Default off; EIGHT_OUTPUT_GATE=1 also enables; the option wins. */
	outputGate?: boolean;
	/**
	 * Headless run (`8gent run`, packages/eight/run.ts): one prompt, no person
	 * at the keyboard, often a local model where every prompt token is prefill
	 * paid on each of many calls. On the local text-tool path the prompt leaves
	 * out what only an interactive session uses (the category catalog of tools
	 * this path does not offer, the personal-fact memory nudge) and declares the
	 * tools to Ollama by name and parameters only, since the system prompt
	 * already lists each one with its description. The tool set, the
	 * parameters, and the tool-call rules are unchanged.
	 */
	headless?: boolean;
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
	/**
	 * This agent's permission mode (#3170): plan, ask, guarded or infinite,
	 * bound to each of its tool calls. The TUI hands every agent of a tab the
	 * tab's holder, so Shift+Tab changes that tab and no other. Undefined: no
	 * mode, today's behaviour.
	 */
	permission?: import("../permissions/permission-mode").PermissionModeHolder;
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
	/**
	 * Optional: isAvailable() with the reason when not, as a predicate phrase
	 * ("did not accept the API key."), so a caller can say why (#3290).
	 */
	readiness?(): Promise<ReadyCheck>;
}

export interface ReadyCheck {
	ok: boolean;
	/** Why not, e.g. "did not accept the API key." Absent when ok. */
	reason?: string;
}
