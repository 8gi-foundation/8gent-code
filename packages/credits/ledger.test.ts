import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TENANT_ZERO, balance, closeLedger, ledgerSnapshot, rows, spend, topup } from "./ledger";

let dir: string;
const saved = { db: process.env.EIGHT_CREDITS_DB, data: process.env.EIGHT_DATA_DIR };
let AgentPool: typeof import("../daemon/agent-pool").AgentPool;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "credits-"));
	process.env.EIGHT_CREDITS_DB = join(dir, "credits.db");
	process.env.EIGHT_DATA_DIR = dir;
	({ AgentPool } = await import("../daemon/agent-pool"));
});

afterAll(() => {
	closeLedger();
	for (const [k, v] of [["EIGHT_CREDITS_DB", saved.db], ["EIGHT_DATA_DIR", saved.data]] as const) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("credit ledger", () => {
	test("balance equals topups minus spends exactly", () => {
		topup("t-bal", 1000);
		topup("t-bal", 500, { payment_ref: null, note: "second" });
		spend("t-bal", 300, "j1");
		spend("t-bal", 1, "j2");
		expect(balance("t-bal")).toBe(1199);
		expect(ledgerSnapshot("t-bal")).toMatchObject({ balance: 1199, topped_up: 1500, spent: 301, jobs_today: 2 });
	});

	test("a re-reported job_id does not double-debit", () => {
		topup("t-dup", 100);
		expect(spend("t-dup", 40, "same")).toBe(true);
		expect(spend("t-dup", 40, "same")).toBe(false);
		expect(balance("t-dup")).toBe(60);
	});

	test("rejects non-positive or fractional tokens and empty tenant", () => {
		expect(() => spend("t-bad", 0, "x")).toThrow();
		expect(() => spend("t-bad", 1.5, "x")).toThrow();
		expect(() => topup("", 5)).toThrow();
	});

	test("a second tenant reads nothing of 8gi", () => {
		topup(TENANT_ZERO, 777);
		expect(balance("other")).toBe(0);
		expect(rows("other")).toEqual([]);
		expect(ledgerSnapshot("other")).toMatchObject({ balance: 0, topped_up: 0, spent: 0, jobs_today: 0, updated: null });
		expect(rows(TENANT_ZERO).every((r) => r.tenant === TENANT_ZERO)).toBe(true);
	});

	test("AgentPool.chat debits 8gi with the agent's real token totals, once per turn", async () => {
		const pool = new AgentPool({ runtime: "ollama", model: "fake" });
		pool.createSession("led-1", "api");
		const usage = { promptTokens: 1200, completionTokens: 345, totalTokens: 1545 };
		const agent = {
			getRuntime: () => "ollama",
			getModel: () => "fake",
			getWorkingDirectory: () => "/w",
			getLastUsage: () => usage,
			async chat(text: string) {
				return `r:${text}`;
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: test swaps the private Agent for a fake
		(pool as any).sessions.get("led-1").agent = agent;
		topup(TENANT_ZERO, 10000);
		const before = balance(TENANT_ZERO);
		await pool.chat("led-1", "hi");
		expect(balance(TENANT_ZERO)).toBe(before - 1545);
		await pool.chat("led-1", "hi again");
		expect(balance(TENANT_ZERO)).toBe(before - 2 * 1545);
		pool.destroySession("led-1");
	});

	test("a turn that reports no usage debits nothing (no chars/4 estimate)", async () => {
		const pool = new AgentPool({ runtime: "ollama", model: "fake" });
		pool.createSession("led-2", "api");
		const agent = {
			getRuntime: () => "ollama",
			getModel: () => "fake",
			getWorkingDirectory: () => "/w",
			getLastUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
			async chat() {
				return "x".repeat(4000);
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: test swaps the private Agent for a fake
		(pool as any).sessions.get("led-2").agent = agent;
		const before = balance(TENANT_ZERO);
		await pool.chat("led-2", "hi");
		expect(balance(TENANT_ZERO)).toBe(before);
		pool.destroySession("led-2");
	});
});
