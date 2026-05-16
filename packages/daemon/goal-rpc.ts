/**
 * Goal-loop RPC surface for the daemon.
 *
 * Spec routes named `goal.*` arrive on the existing WebSocket gateway. This
 * file owns the manager that holds in-flight runs and the message handlers.
 * The actual executor + judge wiring (provider failover, agent-pool reuse)
 * is supplied via a `GoalExecutorFactory` dependency, kept here as an
 * injection point so the scaffold builds without binding to a specific
 * provider stack.
 *
 * Spec note: the build brief told 8TO to register goal RPC inside
 * `packages/daemon/dispatch.ts`. That module is the cross-surface dispatch
 * protocol (replay protection, capability scoping); folding RPC method
 * handlers into it would conflate two responsibilities. Per No-BS rule 7
 * ("call out complexity debt") this lives in a sibling module. Same wiring
 * point in `daemon/index.ts`, zero behavioral difference.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
	GoalLoop,
	GoalPersistence,
	Ledger,
	type GoalEvent,
	type GoalEventSink,
} from "../goal";
import type {
	Budget,
	ExecutorHandle,
	GoalRun,
	JudgeHandle,
	Receipt,
} from "../goal";
import type { WorkspaceDb } from "../db/src/workspace-db";

// ---- Manager-side state -----------------------------------------------------

export interface RunSnapshot {
	runId: string;
	sessionId: string;
	goal: string;
	status: GoalRun["status"];
	stopReason: GoalRun["stopReason"];
	lastVerdict: GoalRun["finalVerdict"];
	counters: GoalRun["counters"];
	receipt: Receipt | null;
	startedAt: number;
	endedAt: number | null;
}

interface InternalRun {
	loop: GoalLoop;
	receipt: Receipt | null;
	settled: Promise<Receipt>;
}

/**
 * The daemon supplies this. Given a sessionId + run params, return wired
 * executor + judge handles. The factory is the only place that knows about
 * AgentPool, ModelFailover, and provider selection.
 *
 * Scaffold contract only; concrete factory lives in a follow-up issue
 * (executor wiring is owned by 8EO).
 */
export interface GoalExecutorFactory {
	build(opts: {
		sessionId: string;
		goal: string;
		executorModelHint?: string;
		judgeModelHint?: string;
	}): Promise<{ executor: ExecutorHandle; judge: JudgeHandle }>;
}

/**
 * Sink contract the manager hands to each loop. The default sink emits
 * events to the daemon bus and forwards them to any persistent ledger
 * (SQLite goal_events, 8GO append-only file).
 */
export type GoalEventListener = (event: GoalEvent) => void;

export class FanoutEventSink implements GoalEventSink {
	constructor(private readonly listeners: GoalEventListener[]) {}
	append(event: GoalEvent): void {
		for (const l of this.listeners) {
			try {
				l(event);
			} catch {
				// Best-effort fan-out.
			}
		}
	}
}

// ---- Manager ---------------------------------------------------------------

export interface GoalManagerDeps {
	factory: GoalExecutorFactory;
	/** Called with every event for every run. Useful for daemon-wide logging. */
	onEvent?: GoalEventListener;
	/** Optional override (tests). */
	now?: () => number;
	/**
	 * Workspace DB handle. When provided, every run is mirrored into the
	 * goal_runs + goal_events tables for UI queries and crash recovery.
	 *
	 * If omitted, runs remain in-memory only (8TO's original behaviour;
	 * still required for the legacy tests in `goal-loop.test.ts`).
	 */
	workspace?: WorkspaceDb;
	/**
	 * HMAC key for signing ledger entries. Required when `workspace` is
	 * provided. In production the daemon loads this from
	 * `~/.8gent/keys/state-hmac.key` (0600). See `packages/goal/ledger.ts`
	 * for the TODO that will swap to `@8gent/permissions` once PR #2616
	 * lands.
	 */
	ledgerKey?: Buffer;
	/**
	 * Base directory for per-run ledger files. Defaults to
	 * `~/.8gent/runs/`. The final path is `<baseDir>/<runId>/ledger.jsonl`.
	 */
	ledgerBaseDir?: string;
}

export class GoalManager {
	private readonly runs = new Map<string, InternalRun>();
	private readonly persistence: GoalPersistence | null;
	private readonly ledgerBaseDir: string;
	private readonly ledgerKey: Buffer | null;

	constructor(private readonly deps: GoalManagerDeps) {
		this.persistence = deps.workspace ? new GoalPersistence(deps.workspace) : null;
		this.ledgerBaseDir =
			deps.ledgerBaseDir ?? path.join(os.homedir(), ".8gent", "runs");
		this.ledgerKey = deps.ledgerKey ?? null;
		if (this.persistence && !this.ledgerKey) {
			// Soft warning, not throw: tests may want persistence without ledger
			// and the daemon entry point owns the real key resolution. In
			// production the daemon must supply both.
			// eslint-disable-next-line no-console
			console.warn(
				"[GoalManager] workspace provided without ledgerKey - ledger writes disabled",
			);
		}
	}

	listIds(): string[] {
		return Array.from(this.runs.keys());
	}

	async start(input: {
		sessionId: string;
		goal: string;
		budget?: Budget;
		executorModelHint?: string;
		judgeModelHint?: string;
	}): Promise<{ runId: string }> {
		if (!input.sessionId) throw new Error("sessionId required");
		if (!input.goal?.trim()) throw new Error("goal required");

		const runId = `g_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
		const { executor, judge } = await this.deps.factory.build({
			sessionId: input.sessionId,
			goal: input.goal,
			executorModelHint: input.executorModelHint,
			judgeModelHint: input.judgeModelHint,
		});

		// Wire persistence + ledger if the daemon supplied them. Falls back
		// to in-memory only when either is absent.
		const listeners: GoalEventListener[] = [];
		if (this.deps.onEvent) listeners.push(this.deps.onEvent);
		let ledger: Ledger | null = null;
		if (this.persistence) {
			// Resolve budget defaults the same way the loop will (so the
			// persisted row matches the loop's resolved budget).
			const { resolveBudget } = await import("../goal/budget");
			const resolved = resolveBudget(input.budget);
			this.persistence.createRun({
				runId,
				sessionId: input.sessionId,
				goalText: input.goal,
				budget: resolved,
				executorModel: executor.model,
				judgeModel: judge.model,
			});
			const persistence = this.persistence;
			listeners.push((event) => {
				try {
					persistence.appendEvent({
						runId: event.runId,
						kind: event.kind,
						payload: { ...event.payload, ts: event.ts },
					});
					if (event.kind === "run.started") {
						persistence.markStarted(event.runId, event.ts);
					}
				} catch (err) {
					// Sink failures must not crash the loop. Audit miss is
					// preferable to terminating an in-flight run.
					// eslint-disable-next-line no-console
					console.warn("[GoalManager] persistence append failed:", err);
				}
			});
		}
		if (this.persistence && this.ledgerKey) {
			ledger = Ledger.open({
				runId,
				baseDir: this.ledgerBaseDir,
				key: this.ledgerKey,
			});
			const led = ledger;
			listeners.push((event) => {
				try {
					led.append({ kind: event.kind, payload: event.payload, now: event.ts });
				} catch (err) {
					// eslint-disable-next-line no-console
					console.warn("[GoalManager] ledger append failed:", err);
				}
			});
		}

		const sink = new FanoutEventSink(listeners);
		const loop = new GoalLoop({
			runId,
			sessionId: input.sessionId,
			goal: input.goal,
			executor,
			judge,
			sink,
			budget: input.budget,
			now: this.deps.now,
		});

		const persistence = this.persistence;
		const ledgerForRun = ledger;
		const settled = loop
			.run_()
			.then((receipt) => {
				const entry = this.runs.get(runId);
				if (entry) entry.receipt = receipt;
				if (persistence) {
					try {
						persistence.markComplete(
							runId,
							receipt.status,
							receipt.stopReason,
							receipt.endedAt,
						);
					} catch (err) {
						// eslint-disable-next-line no-console
						console.warn("[GoalManager] markComplete failed:", err);
					}
				}
				if (ledgerForRun) {
					ledgerForRun.close();
				}
				return receipt;
			})
			.catch((err) => {
				if (ledgerForRun) ledgerForRun.close();
				// Loop has its own defensive catch; this is belt-and-braces.
				throw err;
			});

		this.runs.set(runId, { loop, receipt: null, settled });
		return { runId };
	}

	status(runId: string): RunSnapshot | null {
		const entry = this.runs.get(runId);
		if (!entry) return null;
		const snap = entry.loop.snapshot();
		return {
			runId: snap.id,
			sessionId: snap.sessionId,
			goal: snap.goal,
			status: snap.status,
			stopReason: snap.stopReason,
			lastVerdict: snap.finalVerdict,
			counters: snap.counters,
			receipt: entry.receipt,
			startedAt: snap.startedAt,
			endedAt: snap.endedAt,
		};
	}

	injectSubgoal(runId: string, text: string): boolean {
		const entry = this.runs.get(runId);
		if (!entry) return false;
		entry.loop.injectSubgoal(text);
		return true;
	}

	abort(runId: string): boolean {
		const entry = this.runs.get(runId);
		if (!entry) return false;
		entry.loop.abort();
		return true;
	}

	/**
	 * Daemon-restart recovery hook.
	 *
	 * If the run is in memory, return true immediately.
	 *
	 * If the run is not in memory but is present in the persistence layer,
	 * verify the ledger chain (8GO: every resume must re-verify audit
	 * integrity before exposing the run to RPC callers). Returns true if
	 * the run was hydrated and the chain is intact.
	 *
	 * The scaffold does NOT re-attach a live GoalLoop; the daemon factory
	 * owns executor + judge re-creation. This hook reports readiness; the
	 * higher-level orchestrator (`apps/tui` + `apps/dashboard`) replays
	 * events from `goal_events` to rebuild UI state. Re-running the loop
	 * from a checkpoint is tracked separately.
	 */
	resume(runId: string): boolean {
		if (this.runs.has(runId)) return true;
		if (!this.persistence) return false;
		const row = this.persistence.getRun(runId);
		if (!row) return false;
		if (this.ledgerKey) {
			let ledger: Ledger;
			try {
				ledger = Ledger.open({
					runId,
					baseDir: this.ledgerBaseDir,
					key: this.ledgerKey,
				});
			} catch {
				return false;
			}
			const verdict = ledger.verify();
			ledger.close();
			if (!verdict.ok) {
				// eslint-disable-next-line no-console
				console.warn(
					`[GoalManager] resume(${runId}): ledger verify failed at seq=${verdict.atSeq} - ${verdict.reason}`,
				);
				return false;
			}
		}
		return true;
	}

	/** Expose the persistence layer for UI replays + tests. */
	getPersistence(): GoalPersistence | null {
		return this.persistence;
	}

	/** Await a specific run's completion. Useful for tests and headless mode. */
	wait(runId: string): Promise<Receipt> | null {
		const entry = this.runs.get(runId);
		return entry?.settled ?? null;
	}
}

// ---- Wire-protocol messages -------------------------------------------------
//
// All goal.* messages travel on the existing gateway WebSocket. Inbound
// messages are dispatched from `gateway.handleMessage`; outbound events
// are pushed via the gateway's `event` envelope (kind:"goal.turn" etc.).

export type GoalRpcInbound =
	| {
			type: "goal.start";
			sessionId: string;
			goal: string;
			budget?: Budget;
			judgeModel?: string;
			executorModel?: string;
	  }
	| { type: "goal.status"; runId: string }
	| { type: "goal.subgoal"; runId: string; text: string }
	| { type: "goal.abort"; runId: string }
	| { type: "goal.resume"; runId: string };

export type GoalRpcOutbound =
	| { type: "goal.started"; runId: string }
	| { type: "goal.status"; runId: string; snapshot: RunSnapshot | null }
	| { type: "goal.subgoal:ok"; runId: string; accepted: boolean }
	| { type: "goal.abort:ok"; runId: string; accepted: boolean }
	| { type: "goal.resume:ok"; runId: string; known: boolean }
	| { type: "goal.error"; message: string };

export interface GoalRpcContext {
	manager: GoalManager;
	send: (msg: GoalRpcOutbound) => void;
}

/**
 * Single entry point used by the gateway switch. Returns true if the
 * message was handled (recognized goal.* type), false otherwise so the
 * gateway can fall through to its default branch.
 */
export async function handleGoalRpc(
	raw: unknown,
	ctx: GoalRpcContext,
): Promise<boolean> {
	if (!raw || typeof raw !== "object") return false;
	const msg = raw as { type?: string };
	const t = msg.type;
	if (!t || !t.startsWith("goal.")) return false;

	try {
		switch (t) {
			case "goal.start": {
				const m = raw as Extract<GoalRpcInbound, { type: "goal.start" }>;
				const { runId } = await ctx.manager.start({
					sessionId: m.sessionId,
					goal: m.goal,
					budget: m.budget,
					executorModelHint: m.executorModel,
					judgeModelHint: m.judgeModel,
				});
				ctx.send({ type: "goal.started", runId });
				return true;
			}
			case "goal.status": {
				const m = raw as Extract<GoalRpcInbound, { type: "goal.status" }>;
				const snapshot = ctx.manager.status(m.runId);
				ctx.send({ type: "goal.status", runId: m.runId, snapshot });
				return true;
			}
			case "goal.subgoal": {
				const m = raw as Extract<GoalRpcInbound, { type: "goal.subgoal" }>;
				const accepted = ctx.manager.injectSubgoal(m.runId, m.text);
				ctx.send({ type: "goal.subgoal:ok", runId: m.runId, accepted });
				return true;
			}
			case "goal.abort": {
				const m = raw as Extract<GoalRpcInbound, { type: "goal.abort" }>;
				const accepted = ctx.manager.abort(m.runId);
				ctx.send({ type: "goal.abort:ok", runId: m.runId, accepted });
				return true;
			}
			case "goal.resume": {
				const m = raw as Extract<GoalRpcInbound, { type: "goal.resume" }>;
				const known = ctx.manager.resume(m.runId);
				ctx.send({ type: "goal.resume:ok", runId: m.runId, known });
				return true;
			}
			default: {
				ctx.send({ type: "goal.error", message: `unknown goal rpc method: ${t}` });
				return true;
			}
		}
	} catch (err) {
		ctx.send({
			type: "goal.error",
			message: err instanceof Error ? err.message : String(err),
		});
		return true;
	}
}
