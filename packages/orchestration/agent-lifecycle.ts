/**
 * LifecycleManager - formal agent lifecycle for the orchestration layer.
 *
 * Responsibilities:
 *   - State machine: spawning -> running -> suspended -> resumed -> done
 *   - Pool with configurable concurrency limit
 *   - Priority queue for excess agents
 *   - Suspend: serialize snapshot to workspace storage
 *   - Resume: rehydrate snapshot and continue from checkpoint
 *   - Graceful shutdown: wait for current tool, snapshot, exit
 *   - Telemetry: emit a lifecycle event on every transition
 *
 * The manager is executor-agnostic. Callers pass an `executor` that runs
 * the actual work (LLM calls, tool execution, etc). The executor is given
 * an `ExecutorContext` with cooperative suspend/abort signals and a
 * `checkpoint()` callback to persist progress.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	type AgentLifecycleSnapshot,
	type AgentLifecycleState,
	isTerminal,
	isValidTransition,
} from "@8gent/types";
import { recordLifecycle } from "@8gent/telemetry";

export interface SpawnOptions {
	taskDescription: string;
	priority?: number;
	tenantId?: string;
	clerkId?: string;
	/** Caller-provided id. Generated if omitted. */
	agentId?: string;
	/** Resume from this snapshot instead of starting fresh. */
	resumeFrom?: AgentLifecycleSnapshot;
}

export interface ExecutorContext {
	agentId: string;
	taskDescription: string;
	/** Set when the manager has requested a graceful suspend. */
	readonly suspendRequested: () => boolean;
	/** Set when the manager has requested termination. */
	readonly terminateRequested: () => boolean;
	/** Persist a checkpoint. Called periodically by the executor. */
	checkpoint: (payload: unknown, history?: unknown[]) => void;
	/** Rehydrated snapshot when resuming. Undefined on fresh spawn. */
	resumeFrom?: AgentLifecycleSnapshot;
}

export type Executor = (ctx: ExecutorContext) => Promise<unknown>;

export interface LifecycleManagerOptions {
	/** Max concurrently running agents. Excess are queued. */
	maxConcurrent?: number;
	/** Directory for snapshot files. Defaults to `.8gent/agents/`. */
	snapshotDir?: string;
	/** Default tenant when caller omits one. */
	defaultTenantId?: string;
	/** Disable telemetry emission (for tests). */
	disableTelemetry?: boolean;
}

interface ManagedAgent {
	id: string;
	state: AgentLifecycleState;
	taskDescription: string;
	priority: number;
	tenantId: string;
	clerkId?: string;
	executor: Executor;
	resumeFrom?: AgentLifecycleSnapshot;
	createdAt: string;
	updatedAt: string;
	stateEnteredAt: number;
	conversationHistory: unknown[];
	checkpoint?: unknown;
	pendingToolCall?: { name: string; args: unknown };
	suspendRequested: boolean;
	terminateRequested: boolean;
	resolveDone?: (value: unknown) => void;
	rejectDone?: (err: Error) => void;
	donePromise: Promise<unknown>;
	result?: unknown;
	error?: Error;
}

export class LifecycleManager extends EventEmitter {
	private agents = new Map<string, ManagedAgent>();
	private queue: string[] = [];
	private running = new Set<string>();
	private readonly maxConcurrent: number;
	private readonly snapshotDir: string;
	private readonly defaultTenantId: string;
	private readonly disableTelemetry: boolean;
	private idCounter = 0;

	constructor(options: LifecycleManagerOptions = {}) {
		super();
		this.maxConcurrent = options.maxConcurrent ?? 4;
		this.snapshotDir =
			options.snapshotDir ??
			path.join(process.env.EIGHT_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".8gent"), "agents");
		this.defaultTenantId =
			options.defaultTenantId ?? process.env.EIGHGENT_DEFAULT_TENANT ?? "system";
		this.disableTelemetry = options.disableTelemetry ?? false;
		fs.mkdirSync(this.snapshotDir, { recursive: true });
	}

	/** Spawn a new managed agent with a task and an executor. */
	spawn(options: SpawnOptions, executor: Executor): { agentId: string; done: Promise<unknown> } {
		const agentId = options.agentId ?? this.generateId();
		const now = new Date().toISOString();
		const tenantId = options.tenantId ?? this.defaultTenantId;

		let resolveDone: ((value: unknown) => void) | undefined;
		let rejectDone: ((err: Error) => void) | undefined;
		const donePromise = new Promise<unknown>((res, rej) => {
			resolveDone = res;
			rejectDone = rej;
		});

		const isResume = options.resumeFrom !== undefined;
		const agent: ManagedAgent = {
			id: agentId,
			// Resuming starts at `suspended` so the state machine validly
			// transitions: suspended -> resumed -> running.
			state: isResume ? "suspended" : "spawning",
			taskDescription: options.taskDescription,
			priority: options.priority ?? 1,
			tenantId,
			clerkId: options.clerkId,
			executor,
			resumeFrom: options.resumeFrom,
			createdAt: now,
			updatedAt: now,
			stateEnteredAt: Date.now(),
			conversationHistory: options.resumeFrom?.conversationHistory ?? [],
			checkpoint: options.resumeFrom?.checkpoint,
			pendingToolCall: options.resumeFrom?.pendingToolCall,
			suspendRequested: false,
			terminateRequested: false,
			resolveDone,
			rejectDone,
			donePromise,
		};
		this.agents.set(agentId, agent);
		this.emitTransition(agent, agent.state, undefined, isResume ? "rehydrate" : "spawn");

		// Either start immediately or queue.
		if (this.running.size < this.maxConcurrent) {
			this.startAgent(agentId);
		} else {
			this.enqueue(agentId);
			this.emit("agent:queued", { agentId, priority: agent.priority });
		}

		return { agentId, done: donePromise };
	}

	/**
	 * Resume a previously suspended agent from its snapshot file.
	 * The caller supplies a fresh executor (executors are not serializable).
	 */
	resume(
		agentId: string,
		executor: Executor,
	): { agentId: string; done: Promise<unknown> } {
		const snapshot = this.loadSnapshot(agentId);
		if (!snapshot) {
			throw new Error(`No snapshot found for agent ${agentId}`);
		}
		if (snapshot.state !== "suspended") {
			throw new Error(
				`Snapshot for ${agentId} is not suspended (state=${snapshot.state})`,
			);
		}
		return this.spawn(
			{
				agentId,
				taskDescription: snapshot.taskDescription,
				priority: snapshot.priority,
				tenantId: snapshot.tenantId,
				resumeFrom: snapshot,
			},
			executor,
		);
	}

	/**
	 * Request a graceful suspend. The executor will see `suspendRequested()`
	 * become true and is expected to checkpoint and return at the next safe
	 * boundary (e.g. between tool calls). Resolves once the agent reaches
	 * the `suspended` state.
	 */
	async suspend(agentId: string, reason = "user-request"): Promise<AgentLifecycleSnapshot> {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		if (isTerminal(agent.state)) {
			throw new Error(`Agent ${agentId} is in terminal state ${agent.state}`);
		}
		if (agent.state === "suspended") {
			return this.snapshotOf(agent);
		}
		agent.suspendRequested = true;
		this.emit("agent:suspend-requested", { agentId, reason });
		return new Promise((resolve, reject) => {
			const onSuspended = (snap: AgentLifecycleSnapshot) => {
				if (snap.agentId === agentId) {
					this.off("agent:suspended", onSuspended);
					this.off("agent:failed", onFailed);
					this.off("agent:terminated", onFailed);
					resolve(snap);
				}
			};
			const onFailed = (payload: { agentId: string; error?: string }) => {
				if (payload.agentId === agentId) {
					this.off("agent:suspended", onSuspended);
					this.off("agent:failed", onFailed);
					this.off("agent:terminated", onFailed);
					reject(new Error(payload.error ?? "agent reached terminal state before suspend"));
				}
			};
			this.on("agent:suspended", onSuspended);
			this.on("agent:failed", onFailed);
			this.on("agent:terminated", onFailed);
		});
	}

	/** Request termination. The executor sees `terminateRequested()` become true. */
	terminate(agentId: string, reason = "user-request"): void {
		const agent = this.agents.get(agentId);
		if (!agent || isTerminal(agent.state)) return;
		agent.terminateRequested = true;
		this.emit("agent:terminate-requested", { agentId, reason });

		// If the agent is still queued, terminate immediately.
		const qIdx = this.queue.indexOf(agentId);
		if (qIdx !== -1) {
			this.queue.splice(qIdx, 1);
			this.transition(agent, "terminated", reason);
			agent.resolveDone?.(undefined);
		}
	}

	/**
	 * Graceful shutdown. Suspends every non-terminal agent and waits for
	 * each to reach `suspended` (or terminal). Returns the list of
	 * snapshots written.
	 */
	async shutdown(reason = "graceful-shutdown"): Promise<AgentLifecycleSnapshot[]> {
		const pending: Promise<AgentLifecycleSnapshot | null>[] = [];
		for (const [id, agent] of this.agents) {
			if (isTerminal(agent.state)) continue;
			if (agent.state === "suspended") {
				pending.push(Promise.resolve(this.snapshotOf(agent)));
				continue;
			}
			pending.push(
				this.suspend(id, reason).catch(() => null),
			);
		}
		const results = await Promise.all(pending);
		return results.filter((s): s is AgentLifecycleSnapshot => s !== null);
	}

	/** Read-only view for inspection. */
	getAgent(agentId: string): {
		state: AgentLifecycleState;
		taskDescription: string;
		priority: number;
		queued: boolean;
	} | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;
		return {
			state: agent.state,
			taskDescription: agent.taskDescription,
			priority: agent.priority,
			queued: this.queue.includes(agentId),
		};
	}

	getStats(): {
		total: number;
		running: number;
		queued: number;
		suspended: number;
		completed: number;
		failed: number;
		terminated: number;
		maxConcurrent: number;
	} {
		let running = 0;
		let suspended = 0;
		let completed = 0;
		let failed = 0;
		let terminated = 0;
		for (const agent of this.agents.values()) {
			switch (agent.state) {
				case "running":
				case "spawning":
				case "resumed":
					running++;
					break;
				case "suspended":
					suspended++;
					break;
				case "completed":
					completed++;
					break;
				case "failed":
					failed++;
					break;
				case "terminated":
					terminated++;
					break;
			}
		}
		return {
			total: this.agents.size,
			running,
			queued: this.queue.length,
			suspended,
			completed,
			failed,
			terminated,
			maxConcurrent: this.maxConcurrent,
		};
	}

	/** Path for an agent's snapshot file. Exposed for tests. */
	snapshotPath(agentId: string): string {
		return path.join(this.snapshotDir, `${agentId}.json`);
	}

	/** Load a snapshot from disk. Returns null if absent. */
	loadSnapshot(agentId: string): AgentLifecycleSnapshot | null {
		const file = this.snapshotPath(agentId);
		if (!fs.existsSync(file)) return null;
		try {
			return JSON.parse(fs.readFileSync(file, "utf-8")) as AgentLifecycleSnapshot;
		} catch {
			return null;
		}
	}

	// ----- internals -----

	private enqueue(agentId: string): void {
		// Insert sorted by priority desc; stable on ties.
		const agent = this.agents.get(agentId);
		if (!agent) return;
		const idx = this.queue.findIndex((id) => {
			const other = this.agents.get(id);
			return other ? other.priority < agent.priority : false;
		});
		if (idx === -1) this.queue.push(agentId);
		else this.queue.splice(idx, 0, agentId);
	}

	private startAgent(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		this.running.add(agentId);

		const isResume = agent.resumeFrom !== undefined;
		if (isResume) {
			this.transition(agent, "resumed", "resume");
		}
		this.transition(agent, "running", isResume ? "resumed" : "started");

		const ctx: ExecutorContext = {
			agentId,
			taskDescription: agent.taskDescription,
			suspendRequested: () => agent.suspendRequested,
			terminateRequested: () => agent.terminateRequested,
			checkpoint: (payload: unknown, history?: unknown[]) => {
				agent.checkpoint = payload;
				if (history !== undefined) agent.conversationHistory = history;
				agent.updatedAt = new Date().toISOString();
			},
			resumeFrom: agent.resumeFrom,
		};

		(async () => {
			try {
				const result = await agent.executor(ctx);
				if (agent.suspendRequested && !isTerminal(agent.state)) {
					// Executor cooperatively returned for suspend.
					this.persistSnapshot(agent, "suspended");
					this.transition(agent, "suspended", "executor-cooperative");
					this.emit("agent:suspended", this.snapshotOf(agent));
				} else if (agent.terminateRequested && !isTerminal(agent.state)) {
					this.transition(agent, "terminated", "executor-cooperative");
					agent.resolveDone?.(undefined);
				} else if (!isTerminal(agent.state)) {
					agent.result = result;
					this.transition(agent, "completed", "executor-returned");
					agent.resolveDone?.(result);
				}
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				agent.error = error;
				if (!isTerminal(agent.state)) {
					this.transition(agent, "failed", error.message);
				}
				agent.rejectDone?.(error);
				this.emit("agent:failed", { agentId, error: error.message });
			} finally {
				this.running.delete(agentId);
				this.drainQueue();
			}
		})();
	}

	private drainQueue(): void {
		while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
			const next = this.queue.shift();
			if (next) this.startAgent(next);
		}
	}

	private transition(
		agent: ManagedAgent,
		to: AgentLifecycleState,
		reason: string,
	): void {
		const from = agent.state;
		if (!isValidTransition(from, to)) {
			throw new Error(
				`Invalid lifecycle transition for ${agent.id}: ${from} -> ${to}`,
			);
		}
		const durationMs = Date.now() - agent.stateEnteredAt;
		agent.state = to;
		agent.updatedAt = new Date().toISOString();
		agent.stateEnteredAt = Date.now();
		this.emitTransition(agent, to, from, reason, durationMs);

		if (to === "terminated") {
			this.emit("agent:terminated", { agentId: agent.id, reason });
		}
	}

	private emitTransition(
		agent: ManagedAgent,
		state: AgentLifecycleState,
		prevState: AgentLifecycleState | undefined,
		reason: string,
		durationMs?: number,
	): void {
		this.emit("agent:transition", {
			agentId: agent.id,
			state,
			prevState,
			reason,
			durationMs,
		});
		if (this.disableTelemetry) return;
		try {
			recordLifecycle({
				tenantId: agent.tenantId,
				clerkId: agent.clerkId,
				sessionId: agent.id,
				agentId: agent.id,
				state,
				prevState,
				taskDescription: agent.taskDescription,
				priority: agent.priority,
				reason,
				durationMs,
				error: agent.error?.message,
			});
		} catch {
			// Telemetry must never break the lifecycle path.
		}
	}

	private persistSnapshot(agent: ManagedAgent, asState: AgentLifecycleState): void {
		const snapshot: AgentLifecycleSnapshot = {
			agentId: agent.id,
			state: asState,
			taskDescription: agent.taskDescription,
			priority: agent.priority,
			conversationHistory: agent.conversationHistory,
			pendingToolCall: agent.pendingToolCall,
			checkpoint: agent.checkpoint,
			tenantId: agent.tenantId,
			createdAt: agent.createdAt,
			updatedAt: new Date().toISOString(),
		};
		const file = this.snapshotPath(agent.id);
		// Atomic write: tmp file then rename so a crash mid-write never
		// leaves a half-baked snapshot on disk.
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
		fs.renameSync(tmp, file);
	}

	private snapshotOf(agent: ManagedAgent): AgentLifecycleSnapshot {
		return {
			agentId: agent.id,
			state: agent.state,
			taskDescription: agent.taskDescription,
			priority: agent.priority,
			conversationHistory: agent.conversationHistory,
			pendingToolCall: agent.pendingToolCall,
			checkpoint: agent.checkpoint,
			tenantId: agent.tenantId,
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		};
	}

	private generateId(): string {
		this.idCounter++;
		return `agent-${Date.now()}-${this.idCounter}`;
	}
}
