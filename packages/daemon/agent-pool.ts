/**
 * AgentPool - Manages Agent instances for the daemon.
 *
 * Creates one Agent per session. Routes messages from the gateway
 * to agent.chat() and bridges agent events back to the daemon EventBus.
 */

import { Agent } from "../eight/agent";
import { sessionApiKey } from "../eight/failover-provider-config";
import { LOCAL_PROVIDERS } from "../eight/registry";
import type { AgentConfig, AgentEventCallbacks } from "../eight/types";
import { getUsageMonitor } from "../providers/usage-monitor";
import { type ApprovalTurn, withChannelApprovals } from "./channel-approvals";
import {
	CLASSROOM_AGENT_SCOPE,
	CLASSROOM_CHANNEL,
	CLASSROOM_IDLE_MS,
	CLASSROOM_MAX_TURNS,
	CLASSROOM_SESSION_CAP,
	CLASSROOM_SYSTEM_PROMPT,
} from "./classroom";
import { dataDirPath, getDataDir } from "./data-dir";
import { bus } from "./events";
import { gateInput, isSlashLine } from "./input-gate";
import { type QueueRequest, type QueueStatus, type Receipt, WorkQueue } from "./queue";
import type { SessionJournal } from "./session-journal";

export interface PoolConfig {
	/** Default model to use (e.g. "qwen3.5:14b") */
	model: string;
	/** Runtime provider */
	runtime: "ollama" | "lmstudio" | "openrouter";
	/** Working directory for agent file operations */
	workingDirectory: string;
	/** OpenRouter API key (if runtime is openrouter) */
	apiKey?: string;
	/** Max tool-call turns per chat() invocation */
	maxTurns?: number;
}

interface SessionEntry {
	agent: Agent;
	channel: string;
	createdAt: number;
	lastActiveAt: number;
	messageCount: number;
	busy: boolean; // true while agent.chat() is in flight
	/**
	 * Waiters for this session, FIFO (#3554, EIGHT_SESSION_QUEUE=1 only).
	 * Each is resolved with true when handed the session, or false when the
	 * session ends before its turn.
	 */
	queue: Array<(admitted: boolean) => void>;
	/** Tenant attribution for Wave 4 multi-tenant rollout. */
	tenantId: string;
	/** Optional Clerk ID — useful when tenantId is internal. */
	clerkId?: string;
}

/** Per-session options for AgentPool.createSession. */
export interface SessionOverrides {
	maxTurns?: number;
	tenantId?: string;
	clerkId?: string;
	/**
	 * Restricted policy scope this session's agent gates tool calls under
	 * (e.g. "__table__"). When set, every tool call routes through ToolG8
	 * with this id as the agentId, so the deny-by-default rules installed
	 * for that scope apply. Defaults to the standard "primary" scope.
	 */
	agentScope?: string;
	/**
	 * Per-session backend routing. Lets a caller (e.g. a Table officer
	 * pinned to a specific local model) override the pool defaults for
	 * this one session. `runtime` is still subject to the F4 local-only
	 * gate for Table sessions; a cloud runtime is downgraded to the safe
	 * local default unless EIGHT_TABLE_CONSENT_CLOUD=1. `model`,
	 * `baseUrl`, and `systemPrompt` flow straight into the AgentConfig
	 * (and, via createClient, to the LLM client) when set.
	 */
	runtime?: AgentConfig["runtime"];
	model?: string;
	baseUrl?: string;
	systemPrompt?: string;
	/**
	 * Working directory for this session's tools. Set when a saved TUI
	 * session is attached through the daemon, so its tools keep running in
	 * the project it was started in (#3929). Defaults to the pool's.
	 */
	workingDirectory?: string;
}

const DEFAULT_MODEL = process.env.EIGHGENT_MODEL || "eight:latest";
const DEFAULT_RUNTIME = "ollama" as const;
const MAX_SESSIONS = 10;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** #3554: queue messages to a busy session instead of refusing them. Off by default. */
function sessionQueueEnabled(): boolean {
	return process.env.EIGHT_SESSION_QUEUE === "1";
}

/** #3554: max messages waiting per session (not counting the one running). */
function sessionQueueMax(): number {
	const n = Number(process.env.EIGHT_SESSION_QUEUE_MAX);
	return Number.isInteger(n) && n >= 0 ? n : 32;
}

/** #4254: durable work queue in front of the pool. Off by default. */
function workQueueEnabled(): boolean {
	return process.env.EIGHT_WORK_QUEUE === "1";
}

/** Open the data dir's queue, or null (queue off) when another daemon holds its lock. */
function openWorkQueue(): WorkQueue | null {
	const path = `${dataDirPath()}/work-queue.jsonl`;
	try {
		return new WorkQueue(path, { maxSessions: MAX_SESSIONS });
	} catch (err) {
		console.error(`[agent-pool] ${(err as Error).message}; running with the work queue disabled`);
		return null;
	}
}

/** Known session channels. Add new entries here when wiring a new surface. */
export const KNOWN_CHANNELS = [
	"os",
	"app",
	"telegram",
	"discord",
	"api",
	"delegation",
	"computer",
	"browser",
	"table",
	"tui",
	"classroom",
] as const;
export type Channel = (typeof KNOWN_CHANNELS)[number];

/** Per-channel concurrency caps. Falls back to MAX_SESSIONS when unset. */
const CHANNEL_CAPS: Partial<Record<Channel, number>> = {
	computer: Number(process.env.MAX_COMPUTER_SESSIONS ?? 3),
	classroom: CLASSROOM_SESSION_CAP,
};

/** Per-channel idle timeouts (ms). Falls back to IDLE_TIMEOUT_MS when unset. */
const CHANNEL_IDLE_TIMEOUTS: Partial<Record<Channel, number>> = {
	computer: 10 * 60 * 1000, // 10 minutes
	// Table agent sessions are cheap to rebuild (deterministic sessionId) and
	// should not linger holding a scoped agent; reap them faster than the default.
	table: 10 * 60 * 1000, // 10 minutes
	// Classroom sessions are one-shot lesson generators; do not let them linger.
	classroom: CLASSROOM_IDLE_MS,
};

/** Channels that should never be evicted by the idle reaper. */
const NEVER_EVICT: ReadonlySet<string> = new Set(["telegram", "delegation"]);

export class AgentPool {
	private sessions = new Map<string, SessionEntry>();
	private config: PoolConfig;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	/** Open-session journal for resume after a crash (#3552). Unset by default. */
	private journal: SessionJournal | null;
	/**
	 * True while a client is attached to a session (#3929). The gateway sets
	 * it; an attached session is never evicted for idleness or room.
	 */
	private inUse: (sessionId: string) => boolean = () => false;
	/** Durable work queue (#4254). Null unless EIGHT_WORK_QUEUE=1 or a queue is passed in. */
	private queue: WorkQueue | null;

	constructor(
		config: Partial<PoolConfig> = {},
		options: { journal?: SessionJournal; queue?: WorkQueue } = {},
	) {
		this.journal = options.journal ?? null;
		this.queue = options.queue ?? (workQueueEnabled() ? openWorkQueue() : null);
		for (const id of this.queue?.unknownAfterRestart ?? []) {
			console.warn(
				`[agent-pool] work item ${id} was in flight at shutdown: status unknown, not resent`,
			);
		}
		// Items accepted before a restart run once, after construction finishes.
		if (this.queue) queueMicrotask(() => this.drainQueue());
		this.config = {
			model: config.model || DEFAULT_MODEL,
			runtime: config.runtime || DEFAULT_RUNTIME,
			workingDirectory: config.workingDirectory || process.cwd(),
			apiKey: config.apiKey,
			maxTurns: config.maxTurns || 15, // Hard limit for Telegram - prevents free model loops
		};

		// Clean up idle sessions every 5 minutes
		this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 5 * 60 * 1000);
	}

	/**
	 * Clean stop: stop the idle reaper and close the work queue, which releases its
	 * lock so the next daemon on this data dir takes it without a stale-lock takeover.
	 * Sessions are left as they are (the daemon snapshots them first). Idempotent.
	 */
	shutdown(): void {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		this.cleanupTimer = null;
		this.queue?.close();
		this.queue = null;
	}

	/** Tell the pool which sessions have clients attached (gateway, #3929). */
	setInUse(fn: (sessionId: string) => boolean): void {
		this.inUse = fn;
	}

	/** Whether a session may be evicted to make room or for idleness. */
	private evictable(id: string, entry: SessionEntry): boolean {
		return !NEVER_EVICT.has(entry.channel) && !entry.busy && !this.inUse(id);
	}

	/**
	 * Whether a new session on `channel` fits: under both caps, or with an
	 * evictable session to make room. Restores from disk check this first so
	 * they never push the pool past its cap (#3929).
	 */
	canCreate(channel: string): boolean {
		const entries = [...this.sessions];
		const channelOk =
			this.countOn(channel) < this.capFor(channel) ||
			entries.some(([id, e]) => e.channel === channel && this.evictable(id, e));
		const globalOk =
			this.sessions.size < MAX_SESSIONS || entries.some(([id, e]) => this.evictable(id, e));
		return channelOk && globalOk;
	}

	/** Idle timeout for a given channel (defaults to IDLE_TIMEOUT_MS). */
	private idleTimeoutFor(channel: string): number {
		return CHANNEL_IDLE_TIMEOUTS[channel as Channel] ?? IDLE_TIMEOUT_MS;
	}

	/** Concurrency cap for a given channel (or MAX_SESSIONS if unset). */
	private capFor(channel: string): number {
		return CHANNEL_CAPS[channel as Channel] ?? MAX_SESSIONS;
	}

	/** Count active sessions on a channel. */
	private countOn(channel: string): number {
		let n = 0;
		for (const entry of this.sessions.values()) {
			if (entry.channel === channel) n++;
		}
		return n;
	}

	/** Remove sessions that have been idle for longer than their channel's idle timeout. */
	private cleanupIdleSessions(): void {
		const now = Date.now();
		for (const [id, entry] of this.sessions) {
			// Never evict persistent channels (telegram, delegation)
			if (NEVER_EVICT.has(entry.channel)) continue;
			const timeout = this.idleTimeoutFor(entry.channel);
			if (this.evictable(id, entry) && now - entry.lastActiveAt > timeout) {
				console.log(
					`[agent-pool] evicting idle session ${id} (channel=${entry.channel}, idle ${Math.round((now - entry.lastActiveAt) / 60_000)}m)`,
				);
				this.sessions.delete(id);
				this.unjournal(id);
				bus.emit("session:end", { sessionId: id, reason: "idle-timeout" });
			}
		}
		this.drainQueue();
	}

	/**
	 * Accept a prompt under its requestId (#4254). A repeated requestId gets
	 * the same receipt and never a second run. The item starts when a slot
	 * frees; the queue never evicts a session to make room.
	 */
	submit(req: QueueRequest): { receipt: Receipt; duplicate: boolean } {
		if (!this.queue) throw new Error("work queue is off (set EIGHT_WORK_QUEUE=1)");
		const result = this.queue.enqueue(req);
		if (!result.duplicate) this.drainQueue();
		return result;
	}

	queueStatus(requestId: string): QueueStatus | null {
		return this.queue?.status(requestId) ?? null;
	}

	/** Start waiting items, oldest first, while a slot and the start throttle allow. */
	private drainQueue(): void {
		const q = this.queue;
		if (!q) return;
		for (let item = q.peek(); item; item = q.peek()) {
			const { requestId } = item.receipt;
			const sessionId = item.sessionId ?? `q_${requestId}`;
			const entry = this.sessions.get(sessionId);
			const blocked = entry
				? entry.busy
				: this.sessions.size >= MAX_SESSIONS ||
					this.countOn(item.channel) >= this.capFor(item.channel);
			if (blocked) return; // the head waits, so order holds
			const oneShot = !entry;
			if (oneShot) this.createSession(sessionId, item.channel);
			q.markStarted(requestId);
			this.chat(sessionId, item.text)
				.catch((err) => `[error] ${String(err)}`)
				.then((reply) => {
					q.markEnded(requestId, !reply.startsWith("[error]") && !reply.startsWith("[budget"));
					if (
						oneShot &&
						!q.hasPendingFor(sessionId) &&
						this.sessions.get(sessionId)?.busy === false
					) {
						this.destroySession(sessionId);
						bus.emit("session:end", { sessionId, reason: "queue-done" });
					}
					this.drainQueue();
				});
		}
	}

	/** Create a new session with its own Agent instance */
	createSession(
		sessionId: string,
		channel: string,
		overrides?: SessionOverrides,
		/**
		 * journal: false skips the resume journal write. The boot resume uses
		 * it so the entry keeps naming the old checkpoint until restore succeeds.
		 */
		options: { journal?: boolean } = {},
	): void {
		// Per-channel cap: evict oldest idle session on the same channel first.
		const cap = this.capFor(channel);
		if (this.countOn(channel) >= cap) {
			let oldestId: string | null = null;
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const [id, entry] of this.sessions) {
				if (entry.channel !== channel) continue;
				if (this.evictable(id, entry) && entry.createdAt < oldestTime) {
					oldestTime = entry.createdAt;
					oldestId = id;
				}
			}
			if (oldestId) {
				this.destroySession(oldestId);
				bus.emit("session:end", {
					sessionId: oldestId,
					reason: "channel-cap-evict",
				});
			}
		}

		// Global cap as belt-and-braces: evict oldest idle (any channel).
		if (this.sessions.size >= MAX_SESSIONS) {
			let oldestId: string | null = null;
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const [id, entry] of this.sessions) {
				if (this.evictable(id, entry) && entry.createdAt < oldestTime) {
					oldestTime = entry.createdAt;
					oldestId = id;
				}
			}
			if (oldestId) {
				this.destroySession(oldestId);
				// Clients still holding the id must hear it ended (#3929).
				bus.emit("session:end", { sessionId: oldestId, reason: "channel-cap-evict" });
			}
		}

		const events = this.buildEventCallbacks(sessionId);

		// Classroom (#3939) is fixed by the channel, never by the caller: no tools,
		// a short turn budget, and the untrusted-data system prompt. Overrides for
		// scope, prompt and turns are ignored here on purpose.
		const isClassroom = channel === CLASSROOM_CHANNEL;

		// Delegation sessions get more tool turns than Telegram chat
		const maxTurns = isClassroom
			? Math.min(overrides?.maxTurns ?? CLASSROOM_MAX_TURNS, CLASSROOM_MAX_TURNS)
			: (overrides?.maxTurns ?? (channel === "delegation" ? 25 : this.config.maxTurns));

		// F4: Table sessions must run inference on a LOCAL runtime. A Table agent
		// processes UNTRUSTED channel text; if the runtime is cloud, that text
		// would egress off-box. Any LOCAL provider (8gent/ollama/lmstudio/apfel/
		// apple-foundation - see LOCAL_PROVIDERS) is kept as-is, so an officer
		// explicitly pinned to lmstudio/apfel/apple-foundation stays there. Only a
		// CLOUD runtime is downgraded to the safe local default ("ollama"), unless
		// the operator sets the explicit, logged consent flag.
		//
		// A per-session `overrides.runtime` (e.g. an officer's backend) takes
		// precedence over the pool default before the gate is applied.
		const isTableSession = channel === "table" || overrides?.agentScope === "__table__";
		let runtime: AgentConfig["runtime"] = overrides?.runtime ?? this.config.runtime;
		if (isTableSession && !LOCAL_PROVIDERS.has(runtime)) {
			if (process.env.EIGHT_TABLE_CONSENT_CLOUD === "1") {
				console.warn(
					`[agent-pool] EIGHT_TABLE_CONSENT_CLOUD=1: session ${sessionId} permitted on cloud runtime "${runtime}" (logged consent) - untrusted channel text will egress off-box`,
				);
			} else {
				console.warn(
					`[agent-pool] table session ${sessionId}: forcing LOCAL runtime "ollama" (requested runtime "${runtime}" is not on-box) so untrusted channel text stays on-box; set EIGHT_TABLE_CONSENT_CLOUD=1 to override`,
				);
				runtime = "ollama";
			}
		}

		// Per-session backend routing: an override pins this session to a specific
		// local model / endpoint / persona; otherwise the pool defaults apply.
		const model = overrides?.model ?? this.config.model;

		const agentConfig: AgentConfig = {
			model,
			runtime,
			// Optional explicit endpoint (e.g. an officer's local backend port).
			// createClient() ignores it for clients that don't speak HTTP.
			baseUrl: overrides?.baseUrl,
			// Optional per-session persona (officer character prompt). Undefined
			// leaves the agent on its DEFAULT_SYSTEM_PROMPT.
			systemPrompt: isClassroom ? CLASSROOM_SYSTEM_PROMPT : overrides?.systemPrompt,
			workingDirectory: overrides?.workingDirectory ?? this.config.workingDirectory,
			// The pool key was resolved for the pool's default runtime. A session
			// whose runtime differs (an override, or a Table session forced local)
			// gets only its own runtime's key, never the pool's (#3261).
			apiKey: runtime === this.config.runtime ? this.config.apiKey : sessionApiKey(runtime),
			maxTurns,
			events,
			// Delegation is the personal-OS channel (phone/glasses relay). It needs
			// the full toolset upfront: with deferred loading, models skip the
			// discover_tools hop and silently drop memory writes ("I'll remember
			// that" with no remember call). Capability beats token thrift here.
			allTools: channel === "delegation",
			// Table sessions bind under a restricted deny-by-default scope. Their
			// agent's every tool call gates through ToolG8 as "__table__", so the
			// installTablePolicies() rules block run_command/network/write_file etc.
			// The agent produces only a reply; the gated post_to_channel write path
			// is driven by the gateway. Other channels keep the default scope.
			agentScope: isClassroom
				? CLASSROOM_AGENT_SCOPE
				: (overrides?.agentScope ?? (channel === "table" ? "__table__" : undefined)),
			// Delegation runs UNATTENDED (the relay autonomy engine / missions
			// dispatch through it with no human approving each tool). Mark it so the
			// maker-checker gate enforces at the executor: branch pushes auto-approve
			// (audited), but rm / push-to-main / credentials / deploy hard-block.
			unattended: channel === "delegation",
		};

		const agent = new Agent(agentConfig);

		const now = Date.now();
		// Wave 4 GATE: every session must carry a tenantId. Default to
		// "system" only for legacy callers — production paths must pass
		// the resolved tenantId explicitly.
		const tenantId = overrides?.tenantId ?? process.env.EIGHGENT_DEFAULT_TENANT ?? "system";
		this.sessions.set(sessionId, {
			agent,
			channel,
			createdAt: now,
			lastActiveAt: now,
			messageCount: 0,
			busy: false,
			queue: [],
			tenantId,
			clerkId: overrides?.clerkId,
		});

		if (this.journal && options.journal !== false) {
			try {
				this.journal.upsert({
					sessionId,
					channel,
					ttSessionId: agent.getTimeTravelSessionId(),
					createdAt: now,
					...(overrides ? { overrides } : {}),
				});
			} catch (err) {
				console.error(`[agent-pool] session journal write failed for ${sessionId}: ${String(err)}`);
			}
		}

		console.log(
			`[agent-pool] created session ${sessionId} (channel=${channel}, tenant=${tenantId}, runtime=${runtime}, model=${model})`,
		);
	}

	/** Send a message to an agent and stream the response via the event bus */
	/**
	 * `turn` is set only for a turn the Telegram bridge started on its own
	 * authenticated socket (#3621); then a dangerous command asks the operator.
	 */
	async chat(
		sessionId: string,
		text: string,
		turn?: ApprovalTurn,
		options: { continuation?: boolean } = {},
	): Promise<string> {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			bus.emit("agent:error", { sessionId, error: "session not found" });
			return "[error] session not found";
		}

		// The one choke point before the model (#4530): every caller of chat(), the
		// gateway, the dispatch queue and daemon-built prompts alike, passes the
		// deterministic gate. A daemon-built prompt that starts with a known command
		// name is a bug, so it is logged, not exempted.
		if (isSlashLine(text)) {
			const gated = await gateInput(text, {
				sessionId,
				channel: entry.channel,
				model: entry.agent.getModel(),
				runtime: entry.agent.getRuntime(),
				messageCount: entry.messageCount,
				busy: entry.busy,
			});
			if (gated.handled) {
				if (!turn)
					console.warn(
						`[gate] ${entry.channel} session ${sessionId}: slash line answered without the model (a daemon-built prompt should not start with a slash)`,
					);
				const reply = gated.text ?? "";
				bus.emit("agent:stream", { sessionId, chunk: reply, final: true });
				return reply;
			}
		}

		if (entry.busy) {
			if (!sessionQueueEnabled()) {
				bus.emit("agent:error", {
					sessionId,
					error: "agent is busy processing another message",
				});
				return "[error] agent is busy";
			}
			// #3554: wait in line. The finishing turn hands the session over with
			// busy still true, so nothing can jump the queue in between.
			if (entry.queue.length >= sessionQueueMax()) {
				bus.emit("agent:error", { sessionId, error: "session queue full" });
				return "[error] session queue full";
			}
			const admitted = await new Promise<boolean>((resolve) => entry.queue.push(resolve));
			if (!admitted) return "[error] session ended";
		}
		entry.busy = true;

		// Usage monitor gate - stop burning tokens when limits hit
		const usage = getUsageMonitor();
		const budget = usage.check();
		if (!budget.allowed) {
			const msg = `[budget exceeded] ${budget.reason}. Vessels paused until limits reset.`;
			bus.emit("agent:error", { sessionId, error: msg });
			this.release(entry);
			return msg;
		}
		const warning = usage.getWarning();
		if (warning) {
			bus.emit("agent:stream", {
				sessionId,
				chunk: `[usage warning] ${warning}`,
				final: false,
			});
		}

		// #4082: the turn is on disk before anything is shown, so a crash can
		// continue it. A boot continuation keeps the journaled turn and its
		// attempt count instead of starting a fresh one.
		if (!options.continuation) {
			const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			this.journalTool(sessionId, () => this.journal?.markTurnStart(sessionId, { id, text }));
		}

		entry.messageCount++;
		entry.lastActiveAt = Date.now();
		bus.emit("agent:thinking", { sessionId });

		const startMs = Date.now();
		try {
			const modelCall = (): Promise<string> => entry.agent.chat(text);
			const response = await (turn
				? withChannelApprovals(sessionId, turn, entry.agent.getWorkingDirectory(), modelCall)
				: modelCall());

			// Track token usage (estimate: ~4 chars/token).
			const promptTokens = Math.ceil(text.length / 4);
			const completionTokens = Math.ceil(response.length / 4);
			// Wave 4 GATE: per-tenant attribution. Mirrors local budget AND
			// emits an `llm` event for off-box shipping via Vector + Loki.
			//
			// provider/model come from THIS session's agent (entry.agent), not the
			// pool's `this.config` default. A session created with a per-session
			// override (e.g. a Table officer pinned to their own model/runtime via
			// createSession's `overrides`) runs inference on that override - the
			// pool default is only ever the fallback when no override was given
			// (see createSession above). Reporting `this.config.*` here made every
			// session's telemetry line lie: it always echoed the pool default
			// (~/.8gent/profile.json's models.code), regardless of which backend
			// actually served the reply.
			usage.recordWithAttribution({
				tenantId: entry.tenantId,
				clerkId: entry.clerkId,
				sessionId,
				channel: entry.channel,
				provider: entry.agent.getRuntime(),
				model: entry.agent.getModel(),
				promptTokens,
				completionTokens,
				latencyMs: Date.now() - startMs,
			});

			// Emit the full final response (distinct from stream chunks)
			bus.emit("agent:stream", { sessionId, chunk: response, final: true });

			return response;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			bus.emit("agent:error", { sessionId, error: errorMsg });
			return `[error] ${errorMsg}`;
		} finally {
			// A call aborted mid-turn never sends onToolEnd; the turn is over,
			// so nothing is running any more (#3653), and the turn finished,
			// with an answer or an error, so it is never continued (#4082).
			this.journalTool(sessionId, () => this.journal?.clearInFlight(sessionId));
			this.journalTool(sessionId, () => this.journal?.markTurnEnd(sessionId));
			this.release(entry);
		}
	}

	/** In-flight tool and turn journaling (#3653, #4082). Only with EIGHT_RESUME_ON_BOOT; never fails a turn. */
	private journalTool(sessionId: string, write: () => void): void {
		if (!this.journal) return;
		try {
			write();
		} catch (err) {
			console.error(
				`[agent-pool] in-flight tool journal write failed for ${sessionId}: ${String(err)}`,
			);
		}
	}

	/** Hand the session to the next queued message, or mark it idle. */
	private release(entry: SessionEntry): void {
		const next = entry.queue.shift();
		if (next) next(true);
		else entry.busy = false;
		if (this.queue) queueMicrotask(() => this.drainQueue());
	}

	/** Destroy a session and its Agent */
	destroySession(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;

		this.sessions.delete(sessionId);
		this.unjournal(sessionId);
		// A destroyed session must not keep running its in-flight turn.
		if (entry.busy) {
			try {
				entry.agent.abort();
			} catch (err) {
				console.error(`[agent-pool] abort on destroy failed for ${sessionId}: ${String(err)}`);
			}
		}
		// #3554: queued messages never run on an ended session.
		for (const waiter of entry.queue.splice(0)) waiter(false);
		console.log(`[agent-pool] destroyed session ${sessionId}`);
		if (this.queue) queueMicrotask(() => this.drainQueue());
	}

	private unjournal(sessionId: string): void {
		if (!this.journal) return;
		try {
			this.journal.remove(sessionId);
		} catch (err) {
			console.error(`[agent-pool] session journal remove failed for ${sessionId}: ${String(err)}`);
		}
	}

	/** Check if a session exists */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** Get the Agent instance for a session (time-travel verbs restore into it). */
	getAgent(sessionId: string): Agent | null {
		return this.sessions.get(sessionId)?.agent ?? null;
	}

	/** Get session info */
	getSessionInfo(sessionId: string): {
		channel: string;
		messageCount: number;
		busy: boolean;
		createdAt: number;
		lastActiveAt: number;
	} | null {
		const entry = this.sessions.get(sessionId);
		if (!entry) return null;
		return {
			channel: entry.channel,
			messageCount: entry.messageCount,
			busy: entry.busy,
			createdAt: entry.createdAt,
			lastActiveAt: entry.lastActiveAt,
		};
	}

	/**
	 * Stop the turn in flight without ending the session (#3929): the
	 * shared-safe Stop, since session:destroy would end it for every client.
	 * False when the session does not exist or nothing is running.
	 */
	abort(sessionId: string): boolean {
		const entry = this.sessions.get(sessionId);
		if (!entry || !entry.busy) return false;
		entry.agent.abort();
		return true;
	}

	/** Get count of active sessions */
	get size(): number {
		return this.sessions.size;
	}

	/** Per-channel breakdown for the ops dashboard. */
	getStatus(): {
		total: number;
		globalCap: number;
		channels: Array<{
			channel: string;
			active: number;
			cap: number;
			idleTimeoutMs: number;
		}>;
	} {
		const counts = new Map<string, number>();
		for (const entry of this.sessions.values()) {
			counts.set(entry.channel, (counts.get(entry.channel) ?? 0) + 1);
		}
		// Always surface known channels even when zero so the dashboard is stable.
		const seen = new Set<string>(KNOWN_CHANNELS);
		for (const k of counts.keys()) seen.add(k);
		const channels: Array<{
			channel: string;
			active: number;
			cap: number;
			idleTimeoutMs: number;
		}> = [];
		for (const ch of seen) {
			channels.push({
				channel: ch,
				active: counts.get(ch) ?? 0,
				cap: this.capFor(ch),
				idleTimeoutMs: this.idleTimeoutFor(ch),
			});
		}
		return { total: this.sessions.size, globalCap: MAX_SESSIONS, channels };
	}

	/** Return metadata for all active sessions (for state persistence) */
	getActiveSessions(): Array<{
		sessionId: string;
		channel: string;
		messageCount: number;
		createdAt: number;
	}> {
		const result: Array<{
			sessionId: string;
			channel: string;
			messageCount: number;
			createdAt: number;
		}> = [];
		for (const [id, entry] of this.sessions) {
			result.push({
				sessionId: id,
				channel: entry.channel,
				messageCount: entry.messageCount,
				createdAt: entry.createdAt,
			});
		}
		return result;
	}

	/** Build event callbacks that bridge Agent events to the daemon EventBus */
	private buildEventCallbacks(sessionId: string): AgentEventCallbacks {
		return {
			onToolStart: (event) => {
				this.journalTool(sessionId, () =>
					this.journal?.markToolStart(sessionId, {
						id: event.toolCallId,
						tool: event.toolName,
						args: event.args ?? {},
						startedAt: Date.now(),
					}),
				);
				bus.emit("tool:start", {
					sessionId,
					tool: event.toolName,
					input: event.args,
					toolCallId: event.toolCallId,
				});
			},

			onToolEnd: (event) => {
				this.journalTool(sessionId, () => this.journal?.markToolEnd(sessionId, event.toolCallId));
				bus.emit("tool:result", {
					sessionId,
					tool: event.toolName,
					output: event.resultPreview || "",
					durationMs: event.durationMs,
					toolCallId: event.toolCallId,
					success: event.success,
				});
			},

			onStepFinish: (event) => {
				// Emit the assistant's text response as a stream chunk
				if (event.text) {
					bus.emit("agent:stream", {
						sessionId,
						chunk: event.text,
					});
				}
			},

			onEvidence: (event) => {
				// Evidence is a validation signal - emit as a memory event
				bus.emit("memory:saved", {
					sessionId,
					key: `evidence:${event.type || "validation"}`,
				});
			},
		};
	}
}

/** Load pool config from env vars, then ~/.8gent/config.json as fallback */
export async function loadPoolConfig(): Promise<Partial<PoolConfig>> {
	let fileConfig: Record<string, any> = {};
	try {
		const configPath = `${getDataDir()}/config.json`;
		const file = Bun.file(configPath);
		if (await file.exists()) {
			fileConfig = await file.json();
		}
	} catch {
		// No config file - use env vars and defaults
	}

	const runtime = (process.env.DEFAULT_RUNTIME ||
		fileConfig?.runtime ||
		fileConfig?.provider) as PoolConfig["runtime"];
	return {
		model: process.env.DEFAULT_MODEL || fileConfig?.model || fileConfig?.defaultModel,
		runtime,
		workingDirectory: fileConfig?.workingDirectory || process.cwd(),
		// The OpenRouter env key only for an openrouter runtime (#3261).
		// fileConfig.apiKey names no provider, so it is treated as the
		// OpenRouter key it has always been used as, and only for openrouter.
		apiKey: sessionApiKey(runtime) || (runtime === "openrouter" ? fileConfig?.apiKey : undefined),
		maxTurns: fileConfig?.maxTurns,
	};
}
