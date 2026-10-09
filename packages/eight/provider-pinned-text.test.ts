/**
 * #3746, text-tool path: `--provider ollama` with a model ollama does not have
 * never reroutes the turn to another local provider. Drives the shipping
 * chat() text-tool path (ollama) against a fake ollama that answers every
 * generation with "model not found", while installed-model detection reports
 * models only on LM Studio and Apple Foundation. Any request to another host
 * or port is recorded and refused; the claim is that no generation (POST)
 * goes anywhere but the named provider.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let Agent: typeof import("./agent").Agent;

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: undefined, // ollama takes the text-tool path by default
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
};
let home: string;
let repo: string;
let ollama: ReturnType<typeof Bun.serve>;
const generations: string[] = [];
const elsewhere: string[] = [];
let fetchSpy: { mockRestore: () => void } | undefined;
let detectSpy: { mockRestore: () => void } | undefined;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "pinned3746t-home-"));
	repo = mkdtempSync(join(tmpdir(), "pinned3746t-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });

	ollama = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [{ name: "other:1b" }], data: [] });
			const body = (await req.json().catch(() => ({}))) as { model?: string };
			generations.push(String(body.model));
			return new Response(JSON.stringify({ error: `model '${body.model}' not found` }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		},
	});

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
		if (!local || url.port !== String(ollama.port)) {
			const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
			elsewhere.push(`${method} ${url.toString()}`);
			return Promise.reject(new Error(`test blocks ${url.host}`));
		}
		return realFetch(input, init);
	}) as typeof fetch);

	// Detection would offer two other local providers.
	const detect = await import("../orchestration/local-model-detect");
	detectSpy = spyOn(detect, "detectLocalModels").mockResolvedValue([
		{ provider: "lmstudio", model: "lm-model", score: 9 },
		{ provider: "apple-foundation", model: "apple-foundationmodel", score: 3 },
	] as Awaited<ReturnType<typeof detect.detectLocalModels>>);

	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	ENV.OLLAMA_BASE_URL = `http://127.0.0.1:${ollama.port}`;
	ENV.OLLAMA_HOST = `http://127.0.0.1:${ollama.port}`;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	detectSpy?.mockRestore();
	ollama.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

describe("text-tool path: a pinned ollama with a missing model (#3746)", () => {
	test("the turn ends with the plain pinned message and no other provider is tried", async () => {
		const agent = new Agent({
			model: "missing-m",
			runtime: "ollama",
			workingDirectory: repo,
			baseUrl: `http://127.0.0.1:${ollama.port}`,
			providerPinned: true,
		} as ConstructorParameters<typeof import("./agent").Agent>[0]);
		let reply = "";
		try {
			reply = String(await agent.chat("say done"));
		} catch (e) {
			reply = e instanceof Error ? e.message : String(e);
		}
		expect(generations.length).toBeGreaterThan(0);
		expect(generations.every((m) => m === "missing-m")).toBe(true);
		expect(reply).toContain("ollama/missing-m failed");
		expect(reply).toContain("no other provider was tried");
		expect(elsewhere.filter((r) => r.startsWith("POST "))).toEqual([]);
	}, 60000);
});
