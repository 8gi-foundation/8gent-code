/**
 * Regression test for the /goal-in-TUI bug James reported 2026-05-16:
 * the slash command was registered but nothing happened on submit because
 * `goalClient` was never wired into CommandInput. The fix is in app.tsx
 * (wires a GoalClient backed by InProcessGoalTransport). This test asserts
 * the transport itself routes envelopes to the GoalManager and fans
 * outbound replies back to subscribers — i.e. the contract the GoalClient
 * relies on works end-to-end without a daemon.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GoalExecutorFactory,
	GoalManager,
	type GoalRpcOutbound,
} from "../../../../packages/daemon/goal-rpc.js";
import { GoalClient } from "./goal-client.js";
import { InProcessGoalTransport } from "./in-process-goal-transport.js";

/*
 * Hermetic (#local-probes): these tests start real goal runs. With the default
 * manager each run built the real EightExecutor on the local-first default
 * model, which probed and chatted with THIS machine's Ollama from inside the
 * suite: four POST /v1/chat/completions (404, model not here) and then two
 * more that held the host's Ollama for ~8 s (500), on every run of the suite,
 * and wrote run ledgers into the real ~/.8gent/runs. The transport contract
 * under test does not need a model, so the runs get a stub executor and judge,
 * a temp ledger dir, and a fetch that records any network call and fails.
 */
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-transport-ledger-"));
const stubFactory: GoalExecutorFactory = {
	async build() {
		return {
			executor: {
				model: "stub-executor",
				async turn() {
					return { summary: "stub turn", tokensIn: 1, tokensOut: 1 };
				},
				abort() {},
			},
			judge: {
				model: "stub-judge",
				async score() {
					return { decision: "satisfied" as const, confidence: 1, summary: "stub verdict" };
				},
			},
		};
	},
};
const hermeticTransport = () =>
	new InProcessGoalTransport({
		manager: new GoalManager({ factory: stubFactory, ledgerBaseDir: ledgerDir }),
	});

const realFetch = globalThis.fetch;
let network: string[] = [];
beforeEach(() => {
	network = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		network.push(String(input instanceof Request ? input.url : input));
		return new Response("no network in this test", { status: 503 });
	}) as unknown as typeof fetch;
});
afterEach(async () => {
	// Give a run's background turns time to reach the network if they would.
	await new Promise((r) => setTimeout(r, 300));
	globalThis.fetch = realFetch;
	expect(network).toEqual([]);
});
afterAll(() => {
	fs.rmSync(ledgerDir, { recursive: true, force: true });
});

describe("InProcessGoalTransport", () => {
	it("delivers goal.start → goal.started without a daemon", async () => {
		const transport = hermeticTransport();
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
		const transport = hermeticTransport();
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
		const transport = hermeticTransport();
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
