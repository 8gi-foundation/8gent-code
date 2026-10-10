/**
 * Child agents run where their parent runs (#3710). A child started with
 * spawn_agent inherits the parent session's provider, model and baseUrl, and
 * nothing hosted is looked up, contacted or used for it unless the user opted
 * in with EIGHT_ALLOW_HOSTED=1.
 *
 * These use the real spawnAgentTool, the real AgentPool and the real
 * ModelFailover. Only the child's model loop is replaced, and fetch is a spy
 * that records every request and answers none of them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionHolder, runWithPermissionHolder } from "../permissions/permission-mode";
import { resetFreeModelCache } from "../providers";
import {
	ModelFailover,
	NoAllowedProviderError,
	hostedAllowed,
	isHostedProvider,
} from "../providers/failover";
import { spawnAgentTool } from "./delegation-tools";
import {
	type AgentPool,
	type ChildRuntime,
	getAgentPool,
	getCLIAgentStatus,
	resetOrchestration,
	runAsParentSession,
} from "./index";

const PARENT: ChildRuntime = {
	runtime: "ollama",
	model: "qwen3.8:27b-mlx",
	baseUrl: "http://127.0.0.1:11434",
};

let dir: string;
let pool: AgentPool;
let requests: string[];
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

function isLoopback(url: string): boolean {
	const host = new URL(url).hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

const offBox = () => requests.filter((u) => !isLoopback(u));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "child-provider-"));
	resetOrchestration();
	resetFreeModelCache();
	pool = getAgentPool(10);
	// Children never reach a model here: their loop is a no-op.
	(pool as unknown as { runAgent: (id: string) => Promise<void> }).runAgent = async () => {};
	requests = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requests.push(url);
		throw new Error("network disabled in test");
	}) as unknown as typeof fetch;
	delete process.env.EIGHT_ALLOW_HOSTED;
	delete process.env.EIGHT_PROVIDERS_ALLOW;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	process.env = { ...savedEnv };
	resetOrchestration();
	resetFreeModelCache();
	rmSync(dir, { recursive: true, force: true });
});

const spawnAs = (
	parent: ChildRuntime,
	...args: Parameters<typeof spawnAgentTool> extends [string, ...infer R] ? R : never
) =>
	runAsParentSession(
		() => parent,
		() => spawnAgentTool(dir, ...args),
	);

describe("hosted opt-in flag", () => {
	test("only EIGHT_ALLOW_HOSTED=1 opts in", () => {
		expect(hostedAllowed({})).toBe(false);
		expect(hostedAllowed({ EIGHT_ALLOW_HOSTED: "0" })).toBe(false);
		expect(hostedAllowed({ EIGHT_ALLOW_HOSTED: "true" })).toBe(false);
		expect(hostedAllowed({ EIGHT_ALLOW_HOSTED: "1" })).toBe(true);
	});

	test("local runtimes are not hosted; cloud ones are", () => {
		for (const p of ["8gent", "ollama", "lmstudio", "llama-server", "apfel", "apple-foundation"])
			expect(isHostedProvider(p)).toBe(false);
		for (const p of ["openrouter", "anthropic", "deepseek", "openai", "groq"])
			expect(isHostedProvider(p)).toBe(true);
	});
});

describe("spawn_agent without the opt-in", () => {
	test("a child with no model gets the parent's provider, model and baseUrl", async () => {
		const out = JSON.parse(await spawnAs(PARENT, "task", "8gent"));
		const child = pool.getAgent(out.agentId);
		expect(child?.config.runtime).toBe(PARENT.runtime);
		expect(child?.config.model).toBe(PARENT.model);
		expect(child?.config.baseUrl).toBe(PARENT.baseUrl);
		expect(offBox()).toEqual([]);
	});

	test("the parent's model is read when the child is spawned, not when the session began", async () => {
		let model = "first:7b";
		const out = await runAsParentSession(
			() => ({ runtime: "lmstudio", model }),
			async () => {
				model = "rerouted:14b";
				return JSON.parse(await spawnAgentTool(dir, "task", "8gent"));
			},
		);
		expect(pool.getAgent(out.agentId)?.config).toMatchObject({
			runtime: "lmstudio",
			model: "rerouted:14b",
		});
	});

	test("a named local model runs on the parent's provider", async () => {
		const out = JSON.parse(await spawnAs(PARENT, "task", "8gent", "glm-4.7-flash:latest"));
		expect(pool.getAgent(out.agentId)?.config).toMatchObject({
			runtime: "ollama",
			model: "glm-4.7-flash:latest",
			baseUrl: PARENT.baseUrl,
		});
	});

	test("auto:free is refused, starts nothing and sends no request anywhere", async () => {
		const out = await spawnAs(PARENT, "task", "8gent", "auto:free");
		expect(out).toContain("EIGHT_ALLOW_HOSTED=1");
		expect(pool.listAgents()).toEqual([]);
		expect(requests).toEqual([]);
	});

	test("a hosted free model id is refused", async () => {
		const out = await spawnAs(PARENT, "task", "8gent", "meta-llama/llama-3-8b-instruct:free");
		expect(out).toContain("EIGHT_ALLOW_HOSTED=1");
		expect(pool.listAgents()).toEqual([]);
		expect(requests).toEqual([]);
	});

	test("a hosted parent does not hand its provider to a child", async () => {
		const out = await spawnAs({ runtime: "openrouter", model: "openrouter/auto" }, "task", "8gent");
		expect(out).toContain("EIGHT_ALLOW_HOSTED=1");
		expect(pool.listAgents()).toEqual([]);
	});

	test("the pool itself refuses a hosted child, whoever calls it", async () => {
		await expect(pool.spawnAgent("direct", { runtime: "openrouter", model: "x" })).rejects.toThrow(
			"EIGHT_ALLOW_HOSTED=1",
		);
	});

	test("with no parent session, a child runs on the local default, never glm", async () => {
		process.env.EIGHT_MODEL = "local-pin:8b";
		const out = JSON.parse(await spawnAgentTool(dir, "task", "8gent"));
		expect(pool.getAgent(out.agentId)?.config).toMatchObject({
			runtime: "ollama",
			model: "local-pin:8b",
		});
	});

	test("the claude runtime is refused even in Infinite mode", async () => {
		for (const holder of [createPermissionHolder("infinite"), undefined]) {
			const call = () =>
				spawnAs(PARENT, "task", "claude", undefined, undefined, undefined, "infinite");
			const out = holder ? await runWithPermissionHolder(holder, call) : await call();
			expect(out).toContain("EIGHT_ALLOW_HOSTED=1");
			expect(out).not.toContain("agentId");
		}
	});
});

describe("failover without the opt-in", () => {
	test("a model with no chain is never sent to a hosted provider", () => {
		const fo = new ModelFailover(ModelFailover.defaultChains());
		expect(() => fo.resolve("meta-llama/llama-3-8b-instruct:free")).toThrow(NoAllowedProviderError);
		expect(() => fo.resolve("no-such-model", "computer")).toThrow(NoAllowedProviderError);
		expect(requests).toEqual([]);
	});

	test("default chains end at a local provider, even with every entry marked down", () => {
		const chains = ModelFailover.defaultChains();
		for (const channel of ["text", "computer"] as const) {
			for (const model of Object.keys(chains[channel])) {
				const fo = new ModelFailover(chains);
				let entry: { model: string; provider: string } | null = null;
				try {
					entry = fo.resolve(model, channel);
				} catch (err) {
					expect(err).toBeInstanceOf(NoAllowedProviderError);
					continue;
				}
				for (let i = 0; i < 10 && entry; i++) {
					expect(isHostedProvider(entry.provider)).toBe(false);
					fo.markDown(entry.model, entry.provider);
					entry = fo.resolve(model, channel);
				}
			}
		}
		expect(requests).toEqual([]);
	});

	test("the flag passed explicitly wins over the env", () => {
		process.env.EIGHT_ALLOW_HOSTED = "1";
		const fo = new ModelFailover(ModelFailover.defaultChains(), { allowHosted: false });
		expect(() => fo.resolve("no-such-model")).toThrow(NoAllowedProviderError);
	});
});

describe("with EIGHT_ALLOW_HOSTED=1 the previous behaviour holds", () => {
	beforeEach(() => {
		process.env.EIGHT_ALLOW_HOSTED = "1";
	});

	test("auto:free looks up the free model list and the child runs on it", async () => {
		globalThis.fetch = (async (input: string | URL | Request) => {
			requests.push(String(input));
			return new Response(
				JSON.stringify({
					data: [
						{ id: "small:free", context_length: 8_000 },
						{ id: "big:free", context_length: 128_000 },
					],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const out = JSON.parse(await spawnAs(PARENT, "task", "8gent", "auto:free"));
		expect(requests).toEqual(["https://openrouter.ai/api/v1/models"]);
		expect(pool.getAgent(out.agentId)?.config).toMatchObject({
			runtime: "openrouter",
			model: "big:free",
		});
	});

	test("auto:free with no list reachable fails plainly instead of guessing a model", async () => {
		const out = await spawnAs(PARENT, "task", "8gent", "auto:free");
		expect(out).toContain("could not reach OpenRouter");
		expect(pool.listAgents()).toEqual([]);
	});

	test("failover keeps its hosted tail and the no-chain default", () => {
		const fo = new ModelFailover(ModelFailover.defaultChains());
		expect(fo.resolve("no-such-model").provider).toBe("openrouter");
		fo.markDown("qwen3.5:latest", "ollama");
		const prefixed = ModelFailover.defaultChains().text["qwen3.5:latest"].models;
		for (const e of prefixed) if (e.provider !== "openrouter") fo.markDown(e.model, e.provider);
		expect(fo.resolve("qwen3.5:latest").provider).toBe("openrouter");
	});

	// POSIX only: the fake claude is a shell script, which Windows cannot run as a command.
	test.skipIf(process.platform === "win32")(
		"the claude runtime runs in Infinite mode",
		async () => {
			// A stand-in `claude` on PATH, so the test never starts the real CLI.
			const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
			const fake = join(bin, "claude");
			writeFileSync(fake, "#!/bin/sh\necho fake-claude\n");
			chmodSync(fake, 0o755);
			process.env.PATH = `${bin}:/usr/bin:/bin`;
			try {
				const out = JSON.parse(
					await runWithPermissionHolder(createPermissionHolder("infinite"), () =>
						spawnAs(PARENT, "task", "claude"),
					),
				);
				expect(out.runtime).toBe("claude");
				let status = getCLIAgentStatus(out.agentId);
				for (let i = 0; i < 50 && status?.status === "running"; i++) {
					await new Promise((r) => setTimeout(r, 50));
					status = getCLIAgentStatus(out.agentId);
				}
				expect(status?.result?.stdout.trim()).toBe("fake-claude");
			} finally {
				rmSync(bin, { recursive: true, force: true });
			}
		},
	);
});
