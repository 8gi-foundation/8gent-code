/**
 * TUI-side client for the /goal daemon RPC.
 *
 * This module is the only place in the TUI that knows the shape of the
 * goal.* wire protocol. The rest of the app calls high-level methods
 * (start, status, abort, resume, clear, subgoal) and receives events
 * via subscribe(). The transport is pluggable: production wires the
 * real WebSocket gateway, tests inject a memory transport, and a local
 * fallback queues envelopes when no daemon is reachable so the TUI
 * stays usable offline.
 *
 * Why a thin client rather than calling the daemon's GoalManager
 * directly? Two reasons.
 *
 *   1. Surface symmetry: the daemon already speaks goal.* over a
 *      websocket for telegram / dispatch / api channels. The TUI
 *      should be one more channel on the same protocol, not a special
 *      case wired through internal APIs.
 *   2. Future split: when the TUI moves out of process (it will, for
 *      multi-host vessels), the only thing that changes is the
 *      transport. The component code never touches RPC shapes.
 *
 * Per CLAUDE.md No-BS rule 5: blast radius is one file. The component
 * code in command-input.tsx + LiveFocalStrip.tsx imports this and
 * nothing else from the daemon side.
 */

import type {
	GoalRpcInbound,
	GoalRpcOutbound,
	RunSnapshot,
} from "../../../../packages/daemon/goal-rpc.js";
import type { GoalEvent } from "../../../../packages/goal/index.js";

/**
 * Parsed /goal subcommand. The TUI calls parseGoCommand once per user
 * submission and switches on the result rather than re-parsing in
 * three places.
 */
export type GoSubcommand =
	| { kind: "start"; goal: string }
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "resume" }
	| { kind: "clear" }
	| { kind: "help" }
	| { kind: "invalid"; reason: string };

/**
 * Inline help shown by `/goal ?`. One line per subcommand, no jargon. The
 * 8DO copy bar applies here too: this is user-facing.
 */
export const GO_HELP_LINES: readonly string[] = [
	"/goal <goal>     start a goal-loop run",
	"/goal status     show what's happening now",
	"/goal stop       abort the run",
	"/goal resume     continue a paused run",
	"/goal clear      stop and drop the run state",
	"/goal ?          show this help",
] as const;

/**
 * Parse `/goal ...` argv into a subcommand. The slash-registry has
 * already stripped the leading `/goal` token, so `args` is what came
 * after.
 */
export function parseGoCommand(args: readonly string[]): GoSubcommand {
	if (args.length === 0) {
		return { kind: "invalid", reason: "missing goal text. Try /goal ? for help." };
	}
	const first = (args[0] ?? "").toLowerCase();
	switch (first) {
		case "?":
		case "help":
			return { kind: "help" };
		case "status":
			return { kind: "status" };
		case "stop":
		case "abort":
			return { kind: "stop" };
		case "resume":
			return { kind: "resume" };
		case "clear":
			return { kind: "clear" };
		default: {
			const goal = args.join(" ").trim();
			if (!goal) {
				return { kind: "invalid", reason: "missing goal text" };
			}
			return { kind: "start", goal };
		}
	}
}

/**
 * Transport contract. Anything that can move JSON envelopes both ways
 * is enough; the WebSocket implementation in production satisfies it,
 * the in-memory implementation in tests does too.
 */
export interface GoalTransport {
	send(envelope: GoalRpcInbound): void;
	onMessage(listener: (envelope: GoalRpcOutbound) => void): () => void;
	/** Optional. Used for streaming event envelopes (`goal.turn`, etc.). */
	onEvent?(listener: (event: GoalEvent) => void): () => void;
}

/**
 * Listener bundle for callers (LiveFocalStrip subscribes to all three).
 * Returning unsubscribe closures keeps cleanup predictable in React
 * effects.
 */
export interface GoalClientListeners {
	onStarted?: (runId: string) => void;
	onStatus?: (runId: string, snapshot: RunSnapshot | null) => void;
	onSubgoalAck?: (runId: string, accepted: boolean) => void;
	onAbortAck?: (runId: string, accepted: boolean) => void;
	onResumeAck?: (runId: string, known: boolean) => void;
	onError?: (message: string) => void;
	onTurn?: (event: GoalEvent) => void;
	onJudge?: (event: GoalEvent) => void;
	onDone?: (event: GoalEvent) => void;
	onSubgoalEvent?: (event: GoalEvent) => void;
}

/**
 * The client. Stateless beyond the active runId tracking; everything
 * else lives on the daemon side.
 */
export class GoalClient {
	private currentRunId: string | null = null;
	private readonly transportSubs: Array<() => void> = [];

	constructor(private readonly transport: GoalTransport) {}

	/** Most recently started runId, if any. Used by /goal status / stop / etc. */
	getActiveRunId(): string | null {
		return this.currentRunId;
	}

	/** Test seam + recovery hook for `/goal resume`. */
	setActiveRunId(runId: string | null): void {
		this.currentRunId = runId;
	}

	start(sessionId: string, goal: string): void {
		const trimmed = goal.trim();
		if (!trimmed) {
			throw new Error("goal cannot be empty");
		}
		this.transport.send({
			type: "goal.start",
			sessionId,
			goal: trimmed,
		});
	}

	status(runId?: string): void {
		const target = runId ?? this.currentRunId;
		if (!target) {
			throw new Error("no active run");
		}
		this.transport.send({ type: "goal.status", runId: target });
	}

	subgoal(text: string, runId?: string): void {
		const target = runId ?? this.currentRunId;
		if (!target) {
			throw new Error("no active run");
		}
		const t = text.trim();
		if (!t) {
			throw new Error("subgoal text required");
		}
		this.transport.send({ type: "goal.subgoal", runId: target, text: t });
	}

	abort(runId?: string): void {
		const target = runId ?? this.currentRunId;
		if (!target) {
			throw new Error("no active run");
		}
		this.transport.send({ type: "goal.abort", runId: target });
	}

	resume(runId?: string): void {
		const target = runId ?? this.currentRunId;
		if (!target) {
			throw new Error("no run to resume");
		}
		this.transport.send({ type: "goal.resume", runId: target });
	}

	/**
	 * Stop the current run and drop client-side state. Per epic refinement
	 * comment #4467176878: /goal clear == abort + forget. The daemon's own
	 * ledger is untouched (8GO owns that), the TUI just stops tracking the
	 * runId. Idempotent: safe to call with no active run.
	 */
	clear(): void {
		if (this.currentRunId) {
			try {
				this.transport.send({ type: "goal.abort", runId: this.currentRunId });
			} catch {
				// Best-effort. Tearing down even if the transport is gone.
			}
		}
		this.currentRunId = null;
	}

	/**
	 * Wire listeners onto the transport. Returns a single unsubscribe
	 * that tears down all of them. Components call this in a React
	 * effect with cleanup.
	 */
	subscribe(listeners: GoalClientListeners): () => void {
		const offRpc = this.transport.onMessage((env) => {
			switch (env.type) {
				case "goal.started":
					this.currentRunId = env.runId;
					listeners.onStarted?.(env.runId);
					return;
				case "goal.status":
					listeners.onStatus?.(env.runId, env.snapshot);
					return;
				case "goal.subgoal:ok":
					listeners.onSubgoalAck?.(env.runId, env.accepted);
					return;
				case "goal.abort:ok":
					listeners.onAbortAck?.(env.runId, env.accepted);
					return;
				case "goal.resume:ok":
					listeners.onResumeAck?.(env.runId, env.known);
					return;
				case "goal.error":
					listeners.onError?.(env.message);
					return;
			}
		});

		const offEvents = this.transport.onEvent?.((event) => {
			switch (event.kind) {
				case "turn.completed":
				case "turn.requested":
					listeners.onTurn?.(event);
					return;
				case "judge.verdict":
				case "judge.requested":
					listeners.onJudge?.(event);
					return;
				case "subgoal.injected":
					listeners.onSubgoalEvent?.(event);
					return;
				case "run.completed":
				case "run.failed":
				case "run.aborted":
					listeners.onDone?.(event);
					return;
			}
		});

		const unsub = () => {
			offRpc();
			offEvents?.();
		};
		this.transportSubs.push(unsub);
		return unsub;
	}

	/** Tear down all listeners. Called on TUI shutdown. */
	dispose(): void {
		for (const u of this.transportSubs.splice(0)) {
			try {
				u();
			} catch {
				// Best-effort.
			}
		}
	}
}

/**
 * In-memory transport for tests and the offline fallback. Holds two
 * fan-out lists and exposes a `deliver*` helper for tests to simulate
 * daemon replies.
 */
export class MemoryTransport implements GoalTransport {
	readonly sent: GoalRpcInbound[] = [];
	private readonly msgListeners: Array<(env: GoalRpcOutbound) => void> = [];
	private readonly eventListeners: Array<(event: GoalEvent) => void> = [];

	send(envelope: GoalRpcInbound): void {
		this.sent.push(envelope);
	}

	onMessage(listener: (envelope: GoalRpcOutbound) => void): () => void {
		this.msgListeners.push(listener);
		return () => {
			const i = this.msgListeners.indexOf(listener);
			if (i >= 0) this.msgListeners.splice(i, 1);
		};
	}

	onEvent(listener: (event: GoalEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const i = this.eventListeners.indexOf(listener);
			if (i >= 0) this.eventListeners.splice(i, 1);
		};
	}

	/** Test helper. Push a daemon reply envelope to all subscribers. */
	deliverMessage(env: GoalRpcOutbound): void {
		for (const l of this.msgListeners) l(env);
	}

	/** Test helper. Push a goal event to all subscribers. */
	deliverEvent(event: GoalEvent): void {
		for (const l of this.eventListeners) l(event);
	}
}
