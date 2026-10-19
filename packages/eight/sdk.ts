/**
 * 8gent Code - SDK
 *
 * Embed a session in your own program. One Session wraps one Agent: the same
 * loop the TUI and the JSON-RPC server (rpc-server.ts) run. There is no second
 * loop here; the RPC server is built on this file.
 *
 *   import { createSession } from "@8gi-foundation/8gent-code";
 *   const s = createSession({ model: "qwen3:14b", cwd: process.cwd() });
 *   s.subscribe((e) => e.type === "tool_start" && console.log(e.tool));
 *   console.log(await s.prompt("Create hello.txt"));
 *   await s.dispose();
 */
import { Agent } from "./agent";
import { SessionStore, type StoredMessage } from "./session-store";
import type { AgentConfig, AgentEventCallbacks } from "./types";

// ── Public types ──────────────────────────────────────────────────

export type SessionEvent =
	| { type: "tool_start"; tool: string; args: Record<string, unknown> }
	| { type: "tool_end"; tool: string; result?: string }
	| { type: "text"; text: string }
	| { type: "steer"; text: string }
	| { type: "follow_up"; text: string }
	| { type: "done" }
	| { type: "error"; error: string };

export type SessionListener = (event: SessionEvent) => void;

export interface SessionOptions {
	/** Model name. A known "runtime:" prefix ("openrouter:auto") also selects the runtime. */
	model?: string;
	/** Runtime override. Default: the model prefix, else "ollama". */
	runtime?: string;
	/** Working directory for tools. Default: process.cwd(). */
	cwd?: string;
	systemPrompt?: string;
	/** Session id. Default: rpc_<time>_<random>. Must match [A-Za-z0-9_-]{1,64}. */
	id?: string;
	/** Where the session file lives. Default: ~/.8gent/sessions (or $EIGHT_DATA_DIR/sessions). */
	sessionsDir?: string;
	/** Write the conversation to the session store so it can be listed and forked. Default true. */
	persist?: boolean;
	maxTurns?: number;
	baseUrl?: string;
}

export interface SessionState {
	sessionId: string;
	model: string;
	provider: string;
	cwd: string;
	busy: boolean;
	/** Steers waiting for the running turn plus follow-ups waiting for it to end. */
	queueLength: number;
	steerQueue: number;
	followUpQueue: number;
	messageCount: number;
	persisted: boolean;
}

export interface ChatMessage {
	role: string;
	content: string;
}

/** Thrown for operations this build cannot do (session.compact today). */
export class UnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedError";
	}
}

/** Thrown for a call that is invalid in the session's current state (a turn is already running). */
export class BusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BusyError";
	}
}

// ── Model parsing (shared with the RPC server) ───────────────────

export const KNOWN_RUNTIMES = [
	"openrouter",
	"ollama",
	"lmstudio",
	"anthropic",
	"openai",
	"groq",
	"grok",
	"mistral",
	"8gent",
	"together",
	"fireworks",
	"replicate",
];

/** "openrouter:auto" -> { runtime: "openrouter", model: "auto" }. Other colons stay in the model. */
export function parseModel(
	rawModel: string,
	runtimeOverride?: string,
): { runtime: string; model: string } {
	let runtime = runtimeOverride || "ollama";
	let model = rawModel;
	const colonIdx = rawModel.indexOf(":");
	if (colonIdx > 0) {
		const prefix = rawModel.slice(0, colonIdx);
		if (KNOWN_RUNTIMES.includes(prefix)) {
			runtime = prefix;
			model = rawModel.slice(colonIdx + 1);
		}
	}
	return { runtime, model };
}

function newSessionId(): string {
	return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function asText(content: unknown): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

// ── Session ───────────────────────────────────────────────────────

export class Session {
	readonly id: string;
	readonly cwd: string;
	/** The Agent this session drives. Exposed for hosts that need the full surface. */
	readonly agent: Agent;
	private store: SessionStore | null;
	private readonly sessionsDir: string | undefined;
	private readonly listeners = new Set<SessionListener>();
	private readonly followUps: string[] = [];
	private busy = false;
	private aborted = false;
	private disposed = false;

	/** Use createSession(). */
	constructor(init: {
		id: string;
		cwd: string;
		agent: Agent;
		store: SessionStore | null;
		sessionsDir?: string;
		emitter: { current: ((e: SessionEvent) => void) | null };
	}) {
		this.id = init.id;
		this.cwd = init.cwd;
		this.agent = init.agent;
		this.store = init.store;
		this.sessionsDir = init.sessionsDir;
		init.emitter.current = (e) => this.emit(e);
	}

	private emit(event: SessionEvent): void {
		for (const l of [...this.listeners]) {
			try {
				l(event);
			} catch {
				// A listener must not break the turn.
			}
		}
	}

	/** Receive tool, text, steer and turn-end events. Returns the unsubscribe function. */
	subscribe(listener: SessionListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * One model turn (Agent.chat) and nothing else: queued follow-ups are not
	 * run. This is what the RPC method session.message does. Rejects with
	 * BusyError when a turn is already running (two chats on one agent corrupt
	 * its history); use steer() or followUp() to talk to a running session.
	 */
	async turn(text: string): Promise<string> {
		if (this.disposed) throw new Error("session disposed");
		if (this.busy) {
			throw new BusyError("a turn is already running: use steer or followUp");
		}
		this.busy = true;
		try {
			const response = await this.agent.chat(text);
			this.emit({ type: "done" });
			return response;
		} catch (err) {
			this.emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
			throw err;
		} finally {
			this.busy = false;
			this.persist();
		}
	}

	/**
	 * Run a turn, then keep running until nothing is queued: steers that
	 * arrived too late for the turn (it was already answering) run first, then
	 * follow-ups in order. Resolves with the final assistant text.
	 */
	async prompt(text: string): Promise<string> {
		this.aborted = false;
		let last = await this.turn(text);
		while (!this.aborted && !this.disposed) {
			const late = this.agent.takeQueuedSteers();
			if (late.length > 0) this.followUps.unshift(...late);
			const next = this.followUps.shift();
			if (next === undefined) break;
			this.emit({ type: "follow_up", text: next });
			last = await this.turn(next);
		}
		return last;
	}

	/**
	 * Add a message to the running turn: it joins the conversation after the
	 * tool calls running now finish, before the next model call (Agent.steer).
	 * Returns false when refused (blank, over the size cap, or the queue is full).
	 * With no turn running the text stays queued and prompt() sends it next.
	 */
	steer(text: string): boolean {
		return this.agent.steer(text);
	}

	/** Queue a message for after the current turn ends (run by prompt()). False when blank. */
	followUp(text: string): boolean {
		if (text.trim() === "") return false;
		this.followUps.push(text);
		return true;
	}

	/** Drop every queued steer and follow-up. Returns what was dropped. */
	clearQueue(): { steers: string[]; followUps: string[] } {
		return { steers: this.agent.takeQueuedSteers(), followUps: this.followUps.splice(0) };
	}

	/** Stop the running turn and drop queued follow-ups. Safe when idle. */
	abort(): { followUps: string[] } {
		this.aborted = true;
		this.agent.abort();
		return { followUps: this.followUps.splice(0) };
	}

	getState(): SessionState {
		const steers = this.agent.queuedSteers().length;
		return {
			sessionId: this.id,
			model: this.agent.getModel(),
			provider: this.agent.getRuntime(),
			cwd: this.cwd,
			busy: this.busy,
			queueLength: steers + this.followUps.length,
			steerQueue: steers,
			followUpQueue: this.followUps.length,
			messageCount: this.getMessages().length,
			persisted: this.store !== null,
		};
	}

	/** The conversation, system prompt excluded. */
	getMessages(): ChatMessage[] {
		return this.agent.getMessageHistory().filter((m) => m.role !== "system");
	}

	/** The newest assistant message, or null before the first reply. */
	getLastAssistantText(): string | null {
		const history = this.agent.getMessageHistory();
		for (let i = history.length - 1; i >= 0; i--) {
			if (history[i].role === "assistant") return asText(history[i].content);
		}
		return null;
	}

	/**
	 * Switch the model for the next turn. "runtime:model" is accepted when the
	 * runtime is the one this session already uses; changing runtime needs a new session.
	 */
	setModel(rawModel: string): { model: string; provider: string } {
		const current = this.agent.getRuntime();
		const parsed = parseModel(rawModel, current);
		if (parsed.runtime !== current) {
			throw new RangeError(
				`cannot switch runtime from ${current} to ${parsed.runtime} in a live session: create a new session`,
			);
		}
		if (!parsed.model) throw new RangeError("model required");
		this.agent.setModel(parsed.model);
		return { model: parsed.model, provider: current };
	}

	/** The agent exposes no compaction call on main yet (lane pi-compact). */
	compact(): never {
		throw new UnsupportedError("compaction is not exposed by the agent in this build");
	}

	/**
	 * Copy the stored conversation (up to entryId, default the newest message)
	 * into a new session with its own id and file, and return it live, with the
	 * agent's history restored from the copy. Needs persist (the default).
	 */
	fork(opts: { entryId?: string | null; name?: string } = {}): Session {
		if (!this.store) throw new UnsupportedError("session was created with persist=false: nothing to fork");
		this.persist();
		const child = this.store.fork(opts.entryId === undefined ? undefined : opts.entryId, {
			name: opts.name,
		});
		const messages = child
			.messages()
			.filter((m: StoredMessage) => m.role !== "system")
			.map((m: StoredMessage) => ({ role: m.role, content: asText(m.content) }));
		return buildSession({
			id: child.id,
			cwd: this.cwd,
			model: this.agent.getModel(),
			runtime: this.agent.getRuntime(),
			sessionsDir: this.sessionsDir,
			store: child,
			restore: messages,
		});
	}

	/** Write the conversation into the session store. A store failure never fails a turn. */
	private persist(): void {
		if (!this.store) return;
		try {
			this.store.syncTranscript(this.getMessages());
		} catch (err) {
			process.stderr.write(`[8gent-sdk] session store write failed: ${err}\n`);
		}
	}

	/** Stop the turn, flush the store, release the agent. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.aborted = true;
		this.agent.abort();
		this.persist();
		this.disposed = true;
		this.listeners.clear();
		await this.agent.cleanup();
	}
}

// ── Factory ───────────────────────────────────────────────────────

function buildSession(o: {
	id: string;
	cwd: string;
	model: string;
	runtime: string;
	sessionsDir?: string;
	store: SessionStore | null;
	restore?: ChatMessage[];
	systemPrompt?: string;
	maxTurns?: number;
	baseUrl?: string;
}): Session {
	const emitter: { current: ((e: SessionEvent) => void) | null } = { current: null };
	const emit = (e: SessionEvent) => emitter.current?.(e);
	const events: AgentEventCallbacks = {
		onToolStart: (e) => emit({ type: "tool_start", tool: e.toolName, args: e.args }),
		onToolEnd: (e) => emit({ type: "tool_end", tool: e.toolName, result: e.resultPreview }),
		onStepFinish: (e) => {
			if (e.text) emit({ type: "text", text: e.text });
		},
		onSteer: (e) => emit({ type: "steer", text: e.text }),
	};
	const config: AgentConfig = {
		model: o.model,
		runtime: o.runtime as AgentConfig["runtime"],
		workingDirectory: o.cwd,
		maxTurns: o.maxTurns ?? 30,
		allTools: true,
		events,
		...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
		...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
	};
	const agent = new Agent(config);
	if (o.restore && o.restore.length > 0) agent.restoreFromCheckpoint(o.restore);
	return new Session({
		id: o.id,
		cwd: o.cwd,
		agent,
		store: o.store,
		sessionsDir: o.sessionsDir,
		emitter,
	});
}

/** Create a session. Nothing is sent to a model until prompt() or turn(). */
export function createSession(options: SessionOptions = {}): Session {
	const rawModel = options.model || process.env.EIGHGENT_MODEL || "eight:latest";
	const cwd = options.cwd || process.cwd();
	const { runtime, model } = parseModel(rawModel, options.runtime);
	const id = options.id ?? newSessionId();
	let store: SessionStore | null = null;
	if (options.persist !== false) {
		try {
			store = SessionStore.create(
				{ id, cwd, model, provider: runtime, channel: "rpc" },
				options.sessionsDir,
			);
		} catch (err) {
			if (options.id !== undefined) throw err;
			process.stderr.write(`[8gent-sdk] session store unavailable, not persisting: ${err}\n`);
		}
	}
	return buildSession({
		id,
		cwd,
		model,
		runtime,
		sessionsDir: options.sessionsDir,
		store,
		systemPrompt: options.systemPrompt,
		maxTurns: options.maxTurns,
		baseUrl: options.baseUrl,
	});
}

export { listSessions, type SessionListItem } from "./session-store";
