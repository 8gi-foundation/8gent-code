/**
 * Regression test for the /goal-in-TUI bug James reported 2026-05-16:
 * the slash command was registered but nothing happened on submit because
 * `goalClient` was never wired into CommandInput. The fix is in app.tsx
 * (wires a GoalClient backed by InProcessGoalTransport). This test asserts
 * the transport itself routes envelopes to the GoalManager and fans
 * outbound replies back to subscribers — i.e. the contract the GoalClient
 * relies on works end-to-end without a daemon.
 */

import { describe, expect, it } from "bun:test";
import type { GoalRpcOutbound } from "../../../../packages/daemon/goal-rpc.js";
import { GoalClient } from "./goal-client.js";
import { InProcessGoalTransport } from "./in-process-goal-transport.js";

describe("InProcessGoalTransport", () => {
	it("delivers goal.start → goal.started without a daemon", async () => {
		const transport = new InProcessGoalTransport();
		const messages: GoalRpcOutbound[] = [];
		transport.onMessage((m) => messages.push(m));

		transport.send({
			type: "goal.start",
			sessionId: "test-session",
			goal: "noop goal that will never actually run because the executor would fail without local models",
		});

		// handleGoalRpc is async; let the microtask flush
		await new Promise((r) => setTimeout(r, 10));

		const started = messages.find((m) => m.type === "goal.started");
		expect(started).toBeDefined();
		if (started?.type === "goal.started") {
			expect(started.runId).toBeTruthy();
		}
	});

	it("GoalClient.start over InProcessGoalTransport fires the onStarted listener", async () => {
		const transport = new InProcessGoalTransport();
		const client = new GoalClient(transport);
		let observedRunId: string | null = null;
		const unsub = client.subscribe({
			onStarted: (runId) => {
				observedRunId = runId;
			},
		});

		client.start("tui", "another noop goal");
		await new Promise((r) => setTimeout(r, 10));

		expect(observedRunId).not.toBeNull();
		expect(typeof observedRunId).toBe("string");
		unsub();
	});

	it("reports goal.error on unknown method without wedging", async () => {
		const transport = new InProcessGoalTransport();
		const messages: GoalRpcOutbound[] = [];
		transport.onMessage((m) => messages.push(m));

		// Cast: we are explicitly testing the runtime error path with a
		// malformed envelope the type system would otherwise forbid.
		transport.send({ type: "goal.nonsense" } as unknown as Parameters<typeof transport.send>[0]);
		await new Promise((r) => setTimeout(r, 10));

		const err = messages.find((m) => m.type === "goal.error");
		expect(err).toBeDefined();
	});
});
