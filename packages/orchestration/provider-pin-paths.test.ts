/**
 * #3762: the pin reaches every place a sub-agent can start.
 *
 * The Agent model loop is replaced (chat/isReady are spied); what is asserted
 * is the config each real spawn path hands to `new Agent(...)`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../eight/agent";
import type { AgentConfig as EightConfig } from "../eight/types";
import { PlanValidateLoop } from "../workflow/plan-validate";
import { spawnAgentTool } from "./delegation-tools";
import { type AgentPool, getAgentPool, resetOrchestration } from "./index";
import { runWithProviderPin } from "./provider-pin";
import { runClaimedTask } from "./role-runner";
import { SubAgentManager } from "./subagent";
import { globalDispatcher } from "./task-dispatcher";

type Cfg = Pick<EightConfig, "runtime" | "model" | "providerPinned">;

let dir: string;
const built: Cfg[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

const PIN = { runtime: "lmstudio", model: "qwen-local" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pin-paths-"));
	built.length = 0;
	resetOrchestration();
	spies.push(
		spyOn(Agent.prototype, "isReady").mockResolvedValue(true as never),
		spyOn(Agent.prototype, "chat").mockImplementation(async function (this: Agent) {
			built.push((this as unknown as { config: Cfg }).config);
			return "[]";
		} as never),
	);
});

afterEach(() => {
	for (const s of spies.splice(0)) s.mockRestore();
	resetOrchestration();
	rmSync(dir, { recursive: true, force: true });
});

const seen = () => built.map((c) => ({ runtime: c.runtime, model: c.model, pinned: c.providerPinned }));

describe("the pin reaches every spawn path", () => {
	test("pool runAgent hands providerPinned to new Agent", async () => {
		const pool: AgentPool = getAgentPool(10);
		const out = await runWithProviderPin(PIN, () => spawnAgentTool(dir, "t", "8gent"));
		const { agentId } = JSON.parse(out) as { agentId: string };
		// Let the real runAgent run to its chat() call.
		for (let i = 0; i < 50 && built.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
		expect(pool.getAgent(agentId)).toBeDefined();
		expect(seen()[0]).toEqual({ runtime: "lmstudio", model: "qwen-local", pinned: true });
	});

	test("an un-pinned spawn builds an un-pinned Agent", async () => {
		await spawnAgentTool(dir, "t", "8gent");
		for (let i = 0; i < 50 && built.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
		expect(seen()[0]?.pinned).toBeUndefined();
		expect(seen()[0]?.runtime).toBe("ollama");
	});

	test("two interleaved turns with different pins do not bleed", async () => {
		const spawnLater = async (pin: typeof PIN) =>
			runWithProviderPin(pin, async () => {
				await new Promise((r) => setTimeout(r, Math.random() * 15));
				const out = await spawnAgentTool(dir, "t", "8gent");
				await new Promise((r) => setTimeout(r, Math.random() * 15));
				return (JSON.parse(out) as { agentId: string }).agentId;
			});
		const pool = getAgentPool(10);
		(pool as unknown as { runAgent: () => Promise<void> }).runAgent = async () => {};
		const a = { runtime: "lmstudio", model: "model-a" };
		const b = { runtime: "openrouter", model: "model-b" };
		const ids = await Promise.all([spawnLater(a), spawnLater(b), spawnLater(a), spawnLater(b)]);
		const cfgs = ids.map((id) => pool.getAgent(id)!.config);
		expect(cfgs.map((c) => [c.runtime, c.model])).toEqual([
			["lmstudio", "model-a"],
			["openrouter", "model-b"],
			["lmstudio", "model-a"],
			["openrouter", "model-b"],
		]);
	});

	test("the planner in subagent.ts runs on the pin", async () => {
		const mgr = new SubAgentManager();
		const agent = { task: "x", config: { model: undefined, workingDirectory: dir } };
		await runWithProviderPin(PIN, () =>
			(mgr as unknown as { createPlan: (a: unknown) => Promise<unknown> }).createPlan(agent),
		);
		expect(seen()).toEqual([{ runtime: "lmstudio", model: "qwen-local", pinned: true }]);
	});

	test("the planner with no pin is as before", async () => {
		const mgr = new SubAgentManager();
		const agent = { task: "x", config: { model: undefined, workingDirectory: dir } };
		await (mgr as unknown as { createPlan: (a: unknown) => Promise<unknown> }).createPlan(agent);
		expect(seen()).toEqual([{ runtime: "ollama", model: "glm-4.7-flash:latest", pinned: undefined }]);
	});

	test("plan-validate steps run on the pin", async () => {
		const loop = new PlanValidateLoop({ workingDirectory: dir } as never);
		const step = { id: "s1", action: "a", expected: "e", status: "pending" };
		await runWithProviderPin(PIN, () =>
			(loop as unknown as { executeStep: (s: unknown) => Promise<unknown> }).executeStep(step),
		);
		expect(seen()).toEqual([{ runtime: "lmstudio", model: "qwen-local", pinned: true }]);
	});

	test("role-runner runs the claimed task on the pin, not the role's provider", async () => {
		const id = `pin-role-${Date.now()}`;
		globalDispatcher.enqueue(id, "do it");
		const task = globalDispatcher.claim(id, "engineer")!;
		const res = await runWithProviderPin(PIN, () => runClaimedTask("engineer", task));
		expect(seen()).toEqual([{ runtime: "lmstudio", model: "qwen-local", pinned: true }]);
		expect(res.provider).toBe("lmstudio");
		expect(res.model).toBe("qwen-local");
	});
});

describe("a pinned session will not start another provider's CLI child", () => {
	test("claude CLI child is refused with a plain message under a lmstudio pin", async () => {
		const out = await runWithProviderPin(PIN, () => spawnAgentTool(dir, "t", "claude"));
		expect(out).toContain("pinned to lmstudio");
		expect(out).toContain("will not start a claude CLI agent");
		expect(() => JSON.parse(out)).toThrow();
		expect(getAgentPool(10).listAgents().length).toBe(0);
	});

	test("shell children are not model providers and are not refused by the pin", async () => {
		const out = await runWithProviderPin(PIN, () => spawnAgentTool(dir, "echo hi", "shell"));
		expect(out).not.toContain("pinned to");
	});
});
