/**
 * AgentPool - Manages Agent instances for the daemon.
 *
 * Creates one Agent per session. Routes messages from the gateway
 * to agent.chat() and bridges agent events back to the daemon EventBus.
 */

import { Agent } from "../eight/agent";
import { LOCAL_PROVIDERS } from "../eight/registry";
import type { AgentConfig, AgentEventCallbacks } from "../eight/types";
import { getUsageMonitor } from "../providers/usage-monitor";
import { bus } from "./events";

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
	/** Tenant attribution for Wave 4 multi-tenant rollout. */
	tenantId: string;
	/** Optional Clerk ID — useful when tenantId is internal. */
	clerkId?: string;
}

const DEFAULT_MODEL = process.env.EIGHGENT_MODEL || "eight:latest";
const DEFAULT_RUNTIME = "ollama" as const;
const MAX_SESSIONS = 10;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
] as const;
export type Channel = (typeof KNOWN_CHANNELS)[number];

/** Per-channel concurrency caps. Falls back to MAX_SESSIONS when unset. */
const CHANNEL_CAPS: Partial<Record<Channel, number>> = {
	computer: Number(process.env.MAX_COMPUTER_SESSIONS ?? 3),
};

/** Per-channel idle timeouts (ms). Falls back to IDLE_TIMEOUT_MS when unset. */
const CHANNEL_IDLE_TIMEOUTS: Partial<Record<Channel, number>> = {
	computer: 10 * 60 * 1000, // 10 minutes
	// Table agent sessions are cheap to rebuild (deterministic sessionId) and
	// should not linger holding a scoped agent; reap them faster than the default.
	table: 10 * 60 * 1000, // 10 minutes
};

/** Channels that should never be evicted by the idle reaper. */
const NEVER_EVICT: ReadonlySet<string> = new Set(["telegram", "delegation"]);

export class AgentPool {
	private sessions = new Map<string, SessionEntry>();
	private config: PoolConfig;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: Partial<PoolConfig> = {}) {
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
			if (!entry.busy && now - entry.lastActiveAt > timeout) {
				console.log(
					`[agent-pool] evicting idle session ${id} (channel=${entry.channel}, idle ${Math.round((now - entry.lastActiveAt) / 60_000)}m)`,
				);
				this.sessions.delete(id);
				bus.emit("session:end", { sessionId: id, reason: "idle-timeout" });
			}
		}
	}

	/** Create a new session with its own Agent instance */
	createSession(
		sessionId: string,
		channel: string,
		overrides?: {
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
		},
	): void {
		// Per-channel cap: evict oldest idle session on the same channel first.
		const cap = this.capFor(channel);
		if (this.countOn(channel) >= cap) {
			let oldestId: string | null = null;
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const [id, entry] of this.sessions) {
				if (entry.channel !== channel) continue;
				if (NEVER_EVICT.has(entry.channel)) continue;
				if (!entry.busy && entry.createdAt < oldestTime) {
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
				if (NEVER_EVICT.has(entry.channel)) continue;
				if (!entry.busy && entry.createdAt < oldestTime) {
					oldestTime = entry.createdAt;
					oldestId = id;
				}
			}
			if (oldestId) {
				this.destroySession(oldestId);
			}
		}

		const events = this.buildEventCallbacks(sessionId);

		// Delegation sessions get more tool turns than Telegram chat
		const maxTurns = overrides?.maxTurns ?? (channel === "delegation" ? 25 : this.config.maxTurns);

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
			systemPrompt: overrides?.systemPrompt,
			workingDirectory: this.config.workingDirectory,
			apiKey: this.config.apiKey,
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
			agentScope: overrides?.agentScope ?? (channel === "table" ? "__table__" : undefined),
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
			tenantId,
			clerkId: overrides?.clerkId,
		});

		console.log(
			`[agent-pool] created session ${sessionId} (channel=${channel}, tenant=${tenantId}, runtime=${runtime}, model=${model})`,
		);
	}

	/** Send a message to an agent and stream the response via the event bus */
	async chat(sessionId: string, text: string): Promise<string> {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			bus.emit("agent:error", { sessionId, error: "session not found" });
			return "[error] session not found";
		}

		if (entry.busy) {
			bus.emit("agent:error", {
				sessionId,
				error: "agent is busy processing another message",
			});
			return "[error] agent is busy";
		}

		// Usage monitor gate - stop burning tokens when limits hit
		const usage = getUsageMonitor();
		const budget = usage.check();
		if (!budget.allowed) {
			const msg = `[budget exceeded] ${budget.reason}. Vessels paused until limits reset.`;
			bus.emit("agent:error", { sessionId, error: msg });
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

		entry.busy = true;
		entry.messageCount++;
		entry.lastActiveAt = Date.now();
		bus.emit("agent:thinking", { sessionId });

		const startMs = Date.now();
		try {
			const response = await entry.agent.chat(text);

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
			entry.busy = false;
		}
	}

	/** Destroy a session and its Agent */
	destroySession(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;

		this.sessions.delete(sessionId);
		console.log(`[agent-pool] destroyed session ${sessionId}`);
	}

	/** Check if a session exists */
	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** Get session info */
	getSessionInfo(
		sessionId: string,
	): { channel: string; messageCount: number; busy: boolean } | null {
		const entry = this.sessions.get(sessionId);
		if (!entry) return null;
		return {
			channel: entry.channel,
			messageCount: entry.messageCount,
			busy: entry.busy,
		};
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
				bus.emit("tool:start", {
					sessionId,
					tool: event.toolName,
					input: event.args,
				});
			},

			onToolEnd: (event) => {
				bus.emit("tool:result", {
					sessionId,
					tool: event.toolName,
					output: event.resultPreview || "",
					durationMs: event.durationMs,
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
		const dataDir = process.env.EIGHT_DATA_DIR || `${process.env.HOME}/.8gent`;
		const configPath = `${dataDir}/config.json`;
		const file = Bun.file(configPath);
		if (await file.exists()) {
			fileConfig = await file.json();
		}
	} catch {
		// No config file - use env vars and defaults
	}

	return {
		model: process.env.DEFAULT_MODEL || fileConfig?.model || fileConfig?.defaultModel,
		runtime: (process.env.DEFAULT_RUNTIME ||
			fileConfig?.runtime ||
			fileConfig?.provider) as PoolConfig["runtime"],
		workingDirectory: fileConfig?.workingDirectory || process.cwd(),
		apiKey: process.env.OPENROUTER_API_KEY || fileConfig?.apiKey,
		maxTurns: fileConfig?.maxTurns,
	};
}
