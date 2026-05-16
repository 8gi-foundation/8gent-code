/**
 * InProcessGoalTransport - daemon-less GoalTransport for the TUI.
 *
 * Bridges the GoalClient (which speaks goal.* envelopes) to a local
 * GoalManager instance, no WebSocket or external daemon required.
 *
 * Used when the user types `/goal` in the standalone TUI without a
 * running daemon. The same code path the daemon would take
 * (handleGoalRpc dispatch + event sink fan-out) runs in this process.
 *
 * When the daemon IS running and the TUI connects to it, we'll wire a
 * WebSocketGoalTransport here instead. The interface boundary keeps
 * either path callable from the same GoalClient.
 *
 * 8TO architecture rule: the goal-loop's contract is "executor + judge
 * + budget + sink", and the daemon is just one consumer of that
 * contract. The TUI is another consumer; nothing about it being
 * in-process changes the shape.
 */

import { GoalManager, handleGoalRpc } from "../../../../packages/daemon/goal-rpc.js";
import type {
	GoalRpcInbound,
	GoalRpcOutbound,
} from "../../../../packages/daemon/goal-rpc.js";
import type { GoalEvent } from "../../../../packages/goal/index.js";
import type { GoalTransport } from "./goal-client.js";

export interface InProcessGoalTransportOptions {
	/**
	 * Optional manager override (for tests). Production constructs the
	 * default manager with no deps so it uses DefaultGoalExecutorFactory
	 * (real EightExecutor + FailoverJudge over the local-first chain).
	 */
	manager?: GoalManager;
}

export class InProcessGoalTransport implements GoalTransport {
	private readonly manager: GoalManager;
	private readonly msgListeners: Array<(env: GoalRpcOutbound) => void> = [];
	private readonly eventListeners: Array<(ev: GoalEvent) => void> = [];

	constructor(opts: InProcessGoalTransportOptions = {}) {
		this.manager =
			opts.manager ??
			new GoalManager({
				onEvent: (event) => {
					for (const listener of this.eventListeners) {
						try {
							listener(event);
						} catch {
							// listener errors must not poison the event bus
						}
					}
				},
			});
	}

	send(envelope: GoalRpcInbound): void {
		// Fire-and-forget; outbound replies arrive via msgListeners.
		void handleGoalRpc(envelope, {
			manager: this.manager,
			send: (msg: GoalRpcOutbound) => {
				for (const listener of this.msgListeners) {
					try {
						listener(msg);
					} catch {
						// listener errors must not poison the response path
					}
				}
			},
		});
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
}
