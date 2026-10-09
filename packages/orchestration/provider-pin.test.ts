/**
 * Sub-agents inherit a pinned parent's explicit provider (#3762).
 *
 * Real spawnAgentTool and real AgentPool; only the child's model loop is
 * replaced. The parent binds its pin the way Agent.chat() does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../eight/agent";
import { spawnAgentTool } from "./delegation-tools";
import { type AgentPool, getAgentPool, resetOrchestration } from "./index";
import {
	currentProviderPin,
	inheritedProviderFields,
	pinFromConfig,
	runWithProviderPin,
} from "./provider-pin";

let dir: string;
let pool: AgentPool;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "provider-pin-"));
	resetOrchestration();
	pool = getAgentPool(10);
	// The child never runs a model loop here; only its config matters.
	(pool as unknown as { runAgent: (id: string) => Promise<void> }).runAgent = async () => {};
});

afterEach(() => {
	resetOrchestration();
	rmSync(dir, { recursive: true, force: true });
});

async function spawn(model?: string): Promise<{ runtime?: string; providerPinned?: boolean; model: string }> {
	const out = await spawnAgentTool(dir, "do a thing", "8gent", model);
	const { agentId } = JSON.parse(out) as { agentId: string };
	return pool.getAgent(agentId)!.config as never;
}

describe("sub-agent provider pin", () => {
	test("a sub-agent of a pinned parent is pinned to the parent's provider and model", async () => {
		const parent = pinFromConfig({ runtime: "lmstudio", model: "qwen-local", providerPinned: true });
		const child = await runWithProviderPin(parent, () => spawn());
		expect(child.providerPinned).toBe(true);
		expect(child.runtime).toBe("lmstudio");
		expect(child.model).toBe("qwen-local");
	});

	test("a model the spawner names is kept, the provider is still the parent's", async () => {
		const parent = pinFromConfig({ runtime: "lmstudio", model: "qwen-local", providerPinned: true });
		const child = await runWithProviderPin(parent, () => spawn("other-model"));
		expect(child.runtime).toBe("lmstudio");
		expect(child.providerPinned).toBe(true);
		expect(child.model).toBe("other-model");
	});

	test("a sub-agent of an un-pinned parent is not pinned", async () => {
		const parent = pinFromConfig({ runtime: "ollama", model: "m", providerPinned: false });
		expect(parent).toBeUndefined();
		const child = await runWithProviderPin(parent, () => spawn());
		expect(child.providerPinned).toBeUndefined();
		expect(child.runtime).toBeUndefined();
		expect(child.model).toBe("glm-4.7-flash:latest");
	});

	test("with no parent context at all the child is unchanged", async () => {
		const child = await spawn();
		expect(child.providerPinned).toBeUndefined();
	});

	test("a queued child keeps the pin it was spawned under", async () => {
		const parent = pinFromConfig({ runtime: "openrouter", model: "x/y", providerPinned: true });
		const child = await runWithProviderPin(parent, () => spawn());
		// Read later, outside the parent's context.
		expect(currentProviderPin()).toBeUndefined();
		expect(child.runtime).toBe("openrouter");
		expect(child.providerPinned).toBe(true);
	});

	test("an un-pinned agent clears an outer pin", () => {
		const outer = { runtime: "ollama", model: "m" };
		const seen = runWithProviderPin(outer, () => runWithProviderPin(undefined, currentProviderPin));
		expect(seen).toBeUndefined();
		expect(inheritedProviderFields(undefined)).toEqual({});
	});

	test("Agent.chat binds its own pin for the turn: pinned binds it, un-pinned binds none", async () => {
		const seen: unknown[] = [];
		const probe = (a: Agent) => {
			(a as unknown as { runChat: () => Promise<string> }).runChat = async () => {
				seen.push(currentProviderPin());
				return "ok";
			};
		};
		const pinned = new Agent({ model: "m1", runtime: "lmstudio", providerPinned: true, workingDirectory: dir });
		const loose = new Agent({ model: "m2", runtime: "ollama", workingDirectory: dir });
		probe(pinned);
		probe(loose);
		await pinned.chat("hi");
		await loose.chat("hi");
		expect(seen).toEqual([{ runtime: "lmstudio", model: "m1" }, undefined]);
	});
});
