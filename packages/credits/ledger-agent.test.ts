/**
 * Real agent turns (stubbed provider endpoint, not a stubbed getLastUsage) through
 * AgentPool.chat: both the text-tools and the native path debit tenant 8gi with
 * the endpoint-reported totals, and a turn after clearHistory() never re-debits.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import { TENANT_ZERO, balance, closeLedger, topup } from "./ledger";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	EIGHT_CREDITS: "1",
};
let home: string;
let server: ReturnType<typeof Bun.serve>;
let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
let AgentPool: typeof import("../daemon/agent-pool").AgentPool;
let n = 0;
const savedTextTools = process.env.EIGHT_TEXT_TOOLS;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "credit-agent-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.EIGHT_CREDITS_DB = join(home, "credits.db");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			await req.json();
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: "m",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "A generic constraint limits which types a type parameter accepts." },
						finish_reason: "stop",
					},
				],
				...(usage ? { usage } : {}),
			});
		},
	});
	({ AgentPool } = await import("../daemon/agent-pool"));
	topup(TENANT_ZERO, 1_000_000, { payment_ref: "pay-seed" });
});

afterEach(() => {
	// session() sets EIGHT_TEXT_TOOLS per test; put it back after each one.
	Reflect.deleteProperty(process.env, "EIGHT_TEXT_TOOLS");
	if (savedTextTools !== undefined) process.env.EIGHT_TEXT_TOOLS = savedTextTools;
});

afterAll(() => {
	server?.stop(true);
	closeLedger();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmRetry(home);
});

function session(textTools: "0" | "1") {
	process.env.EIGHT_TEXT_TOOLS = textTools;
	const pool = new AgentPool({ runtime: "ollama", model: "m" });
	const id = `real-${n++}`;
	pool.createSession(id, "api", {
		runtime: "ollama",
		model: "m",
		baseUrl: `http://127.0.0.1:${server.port}`,
		workingDirectory: home,
		// biome-ignore lint/suspicious/noExplicitAny: session overrides shape varies by build
	} as any);
	return { pool, id };
}

const PROMPT = "Using typescript, explain what a generic constraint is in two sentences.";

describe("real agent turns debit the ledger from endpoint-reported usage", () => {
	for (const [label, flag] of [["text-tools", "1"], ["native", "0"]] as const) {
		test(`${label} path debits exactly the reported total`, async () => {
			usage = { prompt_tokens: 700, completion_tokens: 55, total_tokens: 755 };
			const { pool, id } = session(flag);
			const before = balance(TENANT_ZERO);
			await pool.chat(id, PROMPT);
			expect(balance(TENANT_ZERO)).toBe(before - 755);
			pool.destroySession(id);
		}, 60_000);
	}

	test("a turn after clearHistory() does not re-debit the previous total", async () => {
		const { pool, id } = session("1");
		usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
		const b0 = balance(TENANT_ZERO);
		await pool.chat(id, PROMPT);
		expect(balance(TENANT_ZERO)).toBe(b0 - 120);
		// biome-ignore lint/suspicious/noExplicitAny: reach the session's real agent
		(pool as any).sessions.get(id).agent.clearHistory();
		process.env.EIGHT_TEXT_TOOLS = "0";
		usage = null; // endpoint reports nothing this turn
		const b1 = balance(TENANT_ZERO);
		await pool.chat(id, PROMPT);
		expect(balance(TENANT_ZERO)).toBe(b1);
		pool.destroySession(id);
	}, 60_000);
});
