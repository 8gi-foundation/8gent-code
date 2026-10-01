/**
 * #3261: a pool session sends only its own runtime's key.
 *
 * The pool resolves one apiKey for its DEFAULT runtime. A session can run on a
 * different runtime (an override, or a Table session forced to local ollama),
 * and the agent sends the session key to that session's endpoint on every
 * native turn. So a pool on openrouter must never hand the OpenRouter key to
 * an ollama, lmstudio or apfel session. Same for the provider-less
 * `apiKey` in ~/.8gent/config.json.
 *
 * Drives AgentPool.createSession + chat() against a fake OpenAI-compatible
 * endpoint (the session's baseUrl) and asserts on the Authorization header it
 * receives. Non-local hosts are refused so nothing reaches the real network.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OR_KEY = "sk-or-pool-3261";
const FILE_KEY = "sk-file-3261";
const LM_KEY = "lm-own-3261";

interface Seen {
	model: string;
	auth: string | null;
}

const seen: Seen[] = [];
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	EIGHT_TABLE_CONSENT_CLOUD: undefined,
	LM_STUDIO_API_KEY: LM_KEY,
	OPENROUTER_API_KEY: OR_KEY,
	DEFAULT_RUNTIME: undefined,
	DEFAULT_MODEL: undefined,
};
let server: ReturnType<typeof Bun.serve>;
let dataDir: string;
let fetchSpy: { mockRestore: () => void } | undefined;
let AgentPool: typeof import("./agent-pool").AgentPool;
let loadPoolConfig: typeof import("./agent-pool").loadPoolConfig;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "pool3261-data-"));
	for (const [k, v] of Object.entries({ ...ENV, EIGHT_DATA_DIR: dataDir })) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			seen.push({ model: body.model, auth: req.headers.get("authorization") });
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [
					{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
			return Promise.reject(new Error(`test blocks network to ${url.hostname}`));
		}
		return realFetch(input, init);
	}) as typeof fetch);
	({ AgentPool, loadPoolConfig } = await import("./agent-pool"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	server?.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(join(dataDir, "config.json"), { force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;

/** One turn on a fresh pool session; the requests its endpoint received. */
async function sessionTurn(
	pool: InstanceType<typeof AgentPool>,
	id: string,
	channel: string,
	overrides: Parameters<InstanceType<typeof AgentPool>["createSession"]>[2],
): Promise<Seen[]> {
	const start = seen.length;
	pool.createSession(id, channel, overrides);
	try {
		await pool.chat(id, "say done");
	} finally {
		pool.destroySession(id);
	}
	const reqs = seen.slice(start);
	expect(reqs.length).toBeGreaterThan(0);
	return reqs;
}

describe("pool sessions carry only their own runtime's key (#3261)", () => {
	test("an openrouter pool's Table session, forced to ollama, sends no OpenRouter key", async () => {
		const pool = new AgentPool({ runtime: "openrouter", model: "pool-m", apiKey: OR_KEY });
		const reqs = await sessionTurn(pool, "tbl-1", "table", {
			agentScope: "__table__",
			model: "tbl-m",
			baseUrl: base(),
		});
		for (const r of reqs) expect(r.auth).toBeNull();
	}, 30000);

	test("a runtime override gets that runtime's own key, not the pool's", async () => {
		const pool = new AgentPool({ runtime: "openrouter", model: "pool-m", apiKey: OR_KEY });
		const reqs = await sessionTurn(pool, "ov-1", "api", {
			runtime: "lmstudio",
			model: "lm-m",
			baseUrl: base(),
		});
		for (const r of reqs) expect(r.auth).toBe(`Bearer ${LM_KEY}`);
	}, 30000);

	test("a session on the pool's own runtime keeps the pool key", async () => {
		const pool = new AgentPool({ runtime: "openrouter", model: "pool-m", apiKey: OR_KEY });
		const reqs = await sessionTurn(pool, "or-1", "api", { model: "or-m", baseUrl: base() });
		for (const r of reqs) expect(r.auth).toBe(`Bearer ${OR_KEY}`);
	}, 30000);
});

describe("config.json apiKey names no provider (#3261)", () => {
	test("on an ollama runtime it is not used, and reaches no ollama host", async () => {
		delete process.env.OPENROUTER_API_KEY;
		try {
			writeFileSync(
				join(dataDir, "config.json"),
				JSON.stringify({ runtime: "ollama", model: "file-m", apiKey: FILE_KEY }),
			);
			const cfg = await loadPoolConfig();
			expect(cfg.apiKey).toBeUndefined();
			const reqs = await sessionTurn(new AgentPool(cfg), "file-1", "api", { baseUrl: base() });
			for (const r of reqs) expect(r.auth).toBeNull();
		} finally {
			process.env.OPENROUTER_API_KEY = OR_KEY;
		}
	}, 30000);

	test("on an openrouter runtime it stays the OpenRouter key, and a Table session drops it", async () => {
		delete process.env.OPENROUTER_API_KEY;
		try {
			writeFileSync(
				join(dataDir, "config.json"),
				JSON.stringify({ runtime: "openrouter", model: "file-m", apiKey: FILE_KEY }),
			);
			const cfg = await loadPoolConfig();
			expect(cfg.apiKey).toBe(FILE_KEY);
			const reqs = await sessionTurn(new AgentPool(cfg), "file-tbl", "table", {
				agentScope: "__table__",
				model: "tbl-m",
				baseUrl: base(),
			});
			for (const r of reqs) expect(r.auth).toBeNull();
		} finally {
			process.env.OPENROUTER_API_KEY = OR_KEY;
		}
	}, 30000);
});
