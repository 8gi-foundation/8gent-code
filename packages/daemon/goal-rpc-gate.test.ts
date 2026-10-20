/** #4530: goal text reaches the executor's model, so it passes the input gate first. */

import { describe, expect, test } from "bun:test";
import { type GoalManager, type GoalRpcOutbound, handleGoalRpc } from "./goal-rpc";

function setup() {
	const calls: string[] = [];
	const sent: GoalRpcOutbound[] = [];
	const manager = {
		async start(i: { goal: string }) {
			calls.push(`start:${i.goal}`);
			return { runId: "r1" };
		},
		injectSubgoal(_id: string, text: string) {
			calls.push(`sub:${text}`);
			return true;
		},
	} as unknown as GoalManager;
	return { calls, sent, ctx: { manager, send: (m: GoalRpcOutbound) => void sent.push(m) } };
}

describe("goal rpc input gate", () => {
	test("goal.start with a slash line (known or unknown) never reaches the manager", async () => {
		for (const goal of ["/dj status", "/nosuchthing do it"]) {
			const t = setup();
			expect(await handleGoalRpc({ type: "goal.start", sessionId: "s", goal }, t.ctx)).toBe(true);
			expect(t.calls).toEqual([]);
			expect(t.sent[0]?.type).toBe("goal.error");
		}
	});
	test("goal.subgoal with a slash line never reaches the manager", async () => {
		const t = setup();
		await handleGoalRpc({ type: "goal.subgoal", runId: "r", text: "/status" }, t.ctx);
		expect(t.calls).toEqual([]);
		expect(t.sent[0]?.type).toBe("goal.error");
	});
	test("ordinary goal text still starts and injects", async () => {
		const t = setup();
		await handleGoalRpc({ type: "goal.start", sessionId: "s", goal: "ship the thing" }, t.ctx);
		await handleGoalRpc({ type: "goal.subgoal", runId: "r", text: "also this" }, t.ctx);
		expect(t.calls).toEqual(["start:ship the thing", "sub:also this"]);
	});
});
