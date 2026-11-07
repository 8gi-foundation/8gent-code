/**
 * Phone, 7 Nov 2026: "how does my day look today?" on a minimax session ended with
 * "all providers failed (1 tried)". minimax's model has no failover chain of its own,
 * so the native loop stopped after one try; under local-first a local provider must be
 * tried next.
 *
 * Drives the shipping chat() path, as provider-pinned.test does: the minimax session's
 * endpoint is a fake that refuses, ollama is a second fake (OLLAMA_BASE_URL), the chain
 * is the test's own (ModelFailover.loadChains is stubbed) and any other host is refused,
 * so nothing reaches the real network. Hosted stays off (no EIGHT_ALLOW_HOSTED).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;

const seen: Array<{ server: "minimax" | "ollama"; model: string }> = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let ollamaUp = false;
let minimaxPort = 0;
let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

function fake(name: "minimax" | "ollama", ok: () => boolean): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			seen.push({ server: name, model: body.model });
			if (!ok()) {
				const status = name === "minimax" ? 401 : 500;
				const message = name === "minimax" ? "invalid api key" : "model local-a not found";
				return new Response(JSON.stringify({ error: { message } }), {
					status,
					headers: { "content-type": "application/json" },
				});
			}
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
	servers.push(s);
	return s;
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "local-after-hosted-home-"));
	repo = mkdtempSync(join(tmpdir(), "local-after-hosted-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	minimaxPort = fake("minimax", () => false).port ?? 0;
	const ollama = fake("ollama", () => ollamaUp);

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
			return Promise.reject(new Error(`test blocks network to ${url.hostname}`));
		return realFetch(input, init);
	}) as typeof fetch);

	const { ModelFailover } = await import("../providers/failover");
	chainSpy = spyOn(
		ModelFailover.prototype as unknown as { loadChains: () => unknown },
		"loadChains",
	).mockReturnValue({
		// No chain for MiniMax-M2: a hosted registry model, as on the phone.
		text: { "local-a": { models: [{ model: "local-a", provider: "ollama" }] } },
		computer: {},
	});

	const env: Record<string, string | undefined> = {
		EIGHT_TOOL_CAPABILITY_GATE: "0",
		EIGHT_TEXT_TOOLS: "0",
		"8GENT_TWO_STAGE_COMPACT": "0",
		EIGHT_TURN_TIMEOUT_MS: "20000",
		EIGHT_ALLOW_HOSTED: undefined,
		EIGHT_PROVIDERS_ALLOW: undefined,
		OLLAMA_BASE_URL: `http://127.0.0.1:${ollama.port}`,
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
	};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	chainSpy?.mockRestore();
	for (const s of servers) s.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

async function turn(): Promise<{ reqs: typeof seen; out: string }> {
	const start = seen.length;
	const eight = new Agent({
		model: "MiniMax-M2",
		runtime: "minimax",
		apiKey: "k-test",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${minimaxPort}/v1`,
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
	let out = "";
	try {
		out = String((await eight.chat("how does my day look today?")) ?? "");
	} catch (e) {
		out = e instanceof Error ? e.message : String(e);
	}
	return { reqs: seen.slice(start), out };
}

describe("a failed hosted model with no chain moves to a local provider (phone, 7 Nov)", () => {
	test("minimax refuses, ollama answers: the turn is answered locally", async () => {
		ollamaUp = true;
		const { reqs, out } = await turn();
		expect(reqs.some((r) => r.server === "minimax")).toBe(true);
		expect(reqs.some((r) => r.server === "ollama" && r.model === "local-a")).toBe(true);
		expect(out).toContain("Done.");
	}, 30000);

	test("both fail: the error names each provider tried and its error", async () => {
		ollamaUp = false;
		const { out } = await turn();
		expect(out).toMatch(/All providers exhausted \(2 attempted\)/);
		expect(out).toContain("minimax/MiniMax-M2:");
		expect(out).toContain("ollama/local-a:");
	}, 30000);
});
