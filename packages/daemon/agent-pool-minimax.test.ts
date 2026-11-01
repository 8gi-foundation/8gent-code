/**
 * #5100: the daemon can use MiniMax as its runtime, and fails closed.
 *
 * loadPoolConfig picks up only the runtime's own key. A minimax pool refuses to
 * start a session unless the model was verified against the provider's live
 * list, and never falls back to another provider. The lister is injected, so
 * nothing here touches the network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MM_KEY = "mm-test-key-5100";
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
	MINIMAX_API_KEY: MM_KEY,
	OPENROUTER_API_KEY: undefined,
	DEFAULT_RUNTIME: undefined,
	DEFAULT_MODEL: undefined,
	EIGHT_TABLE_CONSENT_CLOUD: undefined,
};
let dataDir: string;
let AgentPool: typeof import("./agent-pool").AgentPool;
let loadPoolConfig: typeof import("./agent-pool").loadPoolConfig;
let pool: InstanceType<typeof AgentPool> | undefined;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "pool5100-data-"));
	for (const [k, v] of Object.entries({ ...ENV, EIGHT_DATA_DIR: dataDir })) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	({ AgentPool, loadPoolConfig } = await import("./agent-pool"));
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(join(dataDir, "config.json"), { force: true });
	delete process.env.DEFAULT_RUNTIME;
});

afterEach(() => {
	pool?.shutdown();
	pool = undefined;
});

describe("loadPoolConfig (#5100)", () => {
	test("a minimax runtime gets the MiniMax key", async () => {
		process.env.DEFAULT_RUNTIME = "minimax";
		const cfg = await loadPoolConfig();
		expect(cfg.runtime).toBe("minimax");
		expect(cfg.apiKey).toBe(MM_KEY);
	});

	test("another runtime never gets the MiniMax key", async () => {
		process.env.DEFAULT_RUNTIME = "ollama";
		expect((await loadPoolConfig()).apiKey).toBeUndefined();
	});
});

describe("minimax pool sessions fail closed (#5100)", () => {
	test("a model on the live list starts a session", async () => {
		pool = new AgentPool(
			{ runtime: "minimax", model: "M" },
			{ listModels: async () => ["M", "N"] },
		);
		await pool.verifyRuntimeModel();
		expect(() => pool?.createSession("ok-1", "api")).not.toThrow();
		pool.destroySession("ok-1");
	});

	test("a model missing from the live list is refused", async () => {
		pool = new AgentPool({ runtime: "minimax", model: "M" }, { listModels: async () => ["N"] });
		await expect(pool.verifyRuntimeModel()).rejects.toThrow(/not on the live model list/);
		expect(() => pool?.createSession("miss-1", "api")).toThrow(/no other provider was tried/);
	});

	test("a list that cannot be fetched is refused, with no fallback", async () => {
		pool = new AgentPool(
			{ runtime: "minimax", model: "M" },
			{
				listModels: async () => {
					throw new Error("network down");
				},
			},
		);
		await expect(pool.verifyRuntimeModel()).rejects.toThrow(/network down/);
		expect(() => pool?.createSession("down-1", "api")).toThrow(/no other provider was tried/);
	});

	test("a session on an unverified model is refused", () => {
		pool = new AgentPool({ runtime: "minimax", model: "M" }, { listModels: async () => ["M"] });
		expect(() => pool?.createSession("raw-1", "api")).toThrow(/not verified/);
	});

	test("a Table session on a minimax pool is still forced local and needs no list", () => {
		pool = new AgentPool({ runtime: "minimax", model: "M" }, { listModels: async () => [] });
		expect(() => pool?.createSession("tbl-1", "table", { agentScope: "__table__" })).not.toThrow();
		pool.destroySession("tbl-1");
	});

	test("an on-box pool is never checked against a list", () => {
		let asked = 0;
		pool = new AgentPool(
			{ runtime: "ollama", model: "M" },
			{
				listModels: async () => {
					asked++;
					return [];
				},
			},
		);
		expect(() => pool?.createSession("loc-1", "api")).not.toThrow();
		pool.destroySession("loc-1");
		expect(asked).toBe(0);
	});
});
