/**
 * Time-travel verbs for the daemon protocol (#2757, step 2).
 *
 * Wire-level rewind/fork on top of the content-addressed checkpoint store
 * shipped in step 1 (packages/eight/timetravel/checkpoint-store.ts):
 *
 *   timetravel:list    -> checkpoints for a session, oldest first
 *   timetravel:rewind  -> replace a live agent's history with an earlier checkpoint
 *   timetravel:fork    -> new pool session seeded from a checkpoint of another
 *                         session; the two lineages then diverge independently
 *
 * The handler is pure protocol logic over two narrow interfaces
 * (TimeTravelPool / TimeTravelAgent) so it is unit-testable without booting
 * the gateway or constructing real Agent instances. gateway.ts owns the
 * side effects (client session rebinding, bus events).
 */

import type { CheckpointMeta } from "../eight/timetravel/checkpoint-store";

// ---- Narrow dependency interfaces -----------------------------------------

export interface TimeTravelRestored {
	meta: CheckpointMeta;
	messages: Array<{ role: string; content: string }>;
}

/** The slice of Agent the verbs need (implemented by packages/eight Agent). */
export interface TimeTravelAgent {
	getTimeTravelSessionId(): string;
	listTimeTravelCheckpoints(): CheckpointMeta[];
	rewindTimeTravel(steps?: number): TimeTravelRestored | null;
	adoptTimeTravelFork(sourceSessionId: string, checkpointId: string): TimeTravelRestored;
}

/** The slice of AgentPool the verbs need. */
export interface TimeTravelPool {
	hasSession(sessionId: string): boolean;
	createSession(sessionId: string, channel: string): void;
	getAgent(sessionId: string): TimeTravelAgent | null;
}

// ---- Wire types ------------------------------------------------------------

export type TimeTravelInbound =
	| { type: "timetravel:list"; sessionId?: string }
	| { type: "timetravel:rewind"; sessionId?: string; steps?: number }
	| { type: "timetravel:fork"; sessionId?: string; checkpointId?: string; channel?: string };

/** CheckpointMeta minus the content hashes - keeps protocol frames small. */
export interface CheckpointSummary {
	id: string;
	parentId: string | null;
	forkedFrom: string | null;
	reason: CheckpointMeta["reason"];
	toolCallCount: number;
	messageCount: number;
	label?: string;
	createdAt: number;
}

export type TimeTravelOutbound =
	| { type: "timetravel:list"; sessionId: string; checkpoints: CheckpointSummary[] }
	| {
			type: "timetravel:rewound";
			sessionId: string;
			steps: number;
			checkpoint: CheckpointSummary;
			messageCount: number;
	  }
	| {
			type: "timetravel:forked";
			sessionId: string;
			sourceSessionId: string;
			forkedFrom: string;
			checkpoint: CheckpointSummary;
			messageCount: number;
	  }
	| { type: "error"; message: string };

export const TIME_TRAVEL_MESSAGE_TYPES = [
	"timetravel:list",
	"timetravel:rewind",
	"timetravel:fork",
] as const;

export function isTimeTravelMessageType(type: string): type is TimeTravelInbound["type"] {
	return (TIME_TRAVEL_MESSAGE_TYPES as readonly string[]).includes(type);
}

// ---- Handler ---------------------------------------------------------------

export interface TimeTravelDeps {
	pool: TimeTravelPool;
	/** The client connection's bound session, used when the message omits one. */
	activeSessionId: string | null;
	/** Channel forked sessions are created on when the message omits one. */
	channel?: string;
	/** Injectable for tests; defaults to the gateway-style `s_` id format. */
	generateSessionId?: () => string;
}

function defaultGenerateSessionId(): string {
	return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toSummary(meta: CheckpointMeta): CheckpointSummary {
	return {
		id: meta.id,
		parentId: meta.parentId,
		forkedFrom: meta.forkedFrom,
		reason: meta.reason,
		toolCallCount: meta.toolCallCount,
		messageCount: meta.messageCount,
		label: meta.label,
		createdAt: meta.createdAt,
	};
}

/**
 * Handle one time-travel protocol message. Always returns an outbound frame;
 * failures come back as `{ type: "error" }` and never throw into the gateway.
 */
export function handleTimeTravel(msg: TimeTravelInbound, deps: TimeTravelDeps): TimeTravelOutbound {
	const sessionId = msg.sessionId ?? deps.activeSessionId;
	if (!sessionId) {
		return { type: "error", message: "timetravel: no session (create or resume one first)" };
	}
	const agent = deps.pool.getAgent(sessionId);
	if (!agent) {
		return { type: "error", message: `timetravel: session ${sessionId} not found` };
	}

	try {
		switch (msg.type) {
			case "timetravel:list": {
				return {
					type: "timetravel:list",
					sessionId,
					checkpoints: agent.listTimeTravelCheckpoints().map(toSummary),
				};
			}

			case "timetravel:rewind": {
				const steps = msg.steps ?? 1;
				if (!Number.isInteger(steps) || steps < 0) {
					return {
						type: "error",
						message: `timetravel: steps must be a non-negative integer, got ${String(msg.steps)}`,
					};
				}
				const restored = agent.rewindTimeTravel(steps);
				if (!restored) {
					return {
						type: "error",
						message: `timetravel: no checkpoint ${steps} step(s) back in ${sessionId}`,
					};
				}
				return {
					type: "timetravel:rewound",
					sessionId,
					steps,
					checkpoint: toSummary(restored.meta),
					messageCount: restored.messages.length,
				};
			}

			case "timetravel:fork": {
				const checkpoints = agent.listTimeTravelCheckpoints();
				const source = msg.checkpointId
					? checkpoints.find((c) => c.id === msg.checkpointId)
					: checkpoints[checkpoints.length - 1];
				if (!source) {
					return {
						type: "error",
						message: msg.checkpointId
							? `timetravel: checkpoint ${msg.checkpointId} not found in ${sessionId}`
							: `timetravel: session ${sessionId} has no checkpoints to fork`,
					};
				}

				const newSessionId = (deps.generateSessionId ?? defaultGenerateSessionId)();
				const channel = msg.channel ?? deps.channel ?? "api";
				deps.pool.createSession(newSessionId, channel);
				const forkAgent = deps.pool.getAgent(newSessionId);
				if (!forkAgent) {
					return {
						type: "error",
						message: `timetravel: failed to create fork session ${newSessionId}`,
					};
				}

				const adopted = forkAgent.adoptTimeTravelFork(agent.getTimeTravelSessionId(), source.id);
				return {
					type: "timetravel:forked",
					sessionId: newSessionId,
					sourceSessionId: sessionId,
					forkedFrom: source.id,
					checkpoint: toSummary(adopted.meta),
					messageCount: adopted.messages.length,
				};
			}
		}
	} catch (err) {
		return { type: "error", message: `timetravel: ${(err as Error).message}` };
	}
}
