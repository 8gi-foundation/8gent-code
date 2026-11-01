/**
 * #4986: the per-turn token budget has a window to default from at turn one.
 * A hosted API provider with a published window gets the budget from the table; a
 * local endpoint stays off until the window lookup has answered, then gets half the
 * real window; EIGHT_TURN_TOKENS wins and 0 turns it off.
 *
 * Production call shape: a real Agent.chat() against a stub OpenAI-compatible
 * endpoint. The Agent's own turnLimits() is wrapped to record what the turn was
 * built with; the real ollamaContextWindowLookup reads the stub's /api/show. $HOME
 * is faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import { ollamaContextWindowLookup } from "../orchestration/local-model-detect";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string | undefined> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TEXT_TOOLS: "1",
	EIGHT_TURN_TOKENS: undefined,
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
/** The context_length /api/show reports, or null for an endpoint that cannot say. */
let serverWindow: number | null = null;
let showCalls = 0;
/** What the stub saw of the lookup when the turn's limits were built, in order. */
let sawWindow: boolean[] = [];

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "budget4986-home-"));
	repo = mkdtempSync(join(tmpdir(), "budget4986-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/show") {
				showCalls++;
				if (serverWindow === null) return new Response("nope", { status: 404 });
				return Response.json({ model_info: { "stub.context_length": serverWindow } });
			}
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
						message: { role: "assistant", content: "DONE: ok" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	process.env.OLLAMA_HOST = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	Reflect.deleteProperty(process.env, "OLLAMA_HOST");
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	removeDir(home);
	removeDir(repo);
});

beforeEach(() => {
	serverWindow = null;
	showCalls = 0;
	sawWindow = [];
	Reflect.deleteProperty(process.env, "EIGHT_TURN_TOKENS");
});

type Limits = { tokens: number } | undefined;

/** An Agent whose turnLimits() records each answer, as the turn asks for it. */
function build(runtime: string, model: string, apiKey?: string) {
	const agent = new Agent({
		model,
		runtime,
		apiKey,
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${server.port}`,
		maxTurns: 4,
	} as ConstructorParameters<typeof Agent>[0]) as AgentT & {
		turnLimits: () => Limits;
	};
	const seen: Limits[] = [];
	const real = agent.turnLimits.bind(agent);
	agent.turnLimits = () => {
		sawWindow.push(showCalls > 0);
		const l = real();
		seen.push(l);
		return l;
	};
	return { agent, seen };
}

const PROMPT = "Using typescript, explain what a generic constraint is in two sentences.";

async function turn(agent: AgentT) {
	// The stub may or may not satisfy a hosted path; the limits are built first.
	await agent.chat(PROMPT).catch(() => "");
}

describe("#4986 the turn budget has a window at turn one", () => {
	test("a hosted provider with a published window has a default budget at turn one, no lookup", async () => {
		const { agent, seen } = build("anthropic", "stub-model", "stub-key");
		await turn(agent);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.tokens).toBe(100000); // half of the table's 200000
		expect(showCalls).toBe(0);
	}, 60_000);

	test("a hosted provider with no trusted window stays off", async () => {
		const { agent, seen } = build("openrouter", "stub-model", "stub-key");
		await turn(agent);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.tokens).toBe(0);
	}, 60_000);

	test("a local model sends no lookup ahead of chat; settle reads the window and sets half of it", async () => {
		serverWindow = 131072;
		const { agent, seen } = build("ollama", "stub-local:27b");
		await turn(agent);
		expect(showCalls).toBe(0); // nothing reached the host that chat did not send
		const limits = seen[0] as { tokens: number; settle?: () => Promise<void> };
		expect(limits.tokens).toBe(0);
		expect(typeof limits.settle).toBe("function");
		await limits.settle?.(); // what the first counted tool call triggers
		expect(limits.tokens).toBe(65536);
		expect(showCalls).toBe(1);
		await turn(agent);
		expect(showCalls).toBe(1); // cached for the session
		expect(seen[seen.length - 1]?.tokens).toBe(65536);
	}, 60_000);

	test("a local model whose window cannot be read has no budget, and no 16k guess", async () => {
		serverWindow = null;
		const { agent, seen } = build("ollama", "stub-local:27b");
		await turn(agent);
		const limits = seen[0] as { tokens: number; settle?: () => Promise<void> };
		await limits.settle?.();
		expect(showCalls).toBe(1);
		expect(limits.tokens).toBe(0);
	}, 60_000);

	test("a wrong-shape reply from the host does not throw", async () => {
		const bodies: unknown[] = [{ models: "x" }, [], "text", 7, null];
		for (const body of bodies) {
			const w = await ollamaContextWindowLookup({ baseUrl: "http://h", model: "m" }, (async () =>
				Response.json(body)) as unknown as typeof fetch);
			expect(w).toBeNull();
		}
	});

	test("EIGHT_TURN_TOKENS wins over both sources", async () => {
		process.env.EIGHT_TURN_TOKENS = "1234";
		serverWindow = 131072;
		const local = build("ollama", "stub-local:27b");
		await turn(local.agent);
		expect(local.seen[0]?.tokens).toBe(1234);
		const cloud = build("anthropic", "stub-model", "stub-key");
		await turn(cloud.agent);
		expect(cloud.seen[0]?.tokens).toBe(1234);
	}, 60_000);

	test("EIGHT_TURN_TOKENS=0 disables the budget on a hosted provider", async () => {
		process.env.EIGHT_TURN_TOKENS = "0";
		const { agent, seen } = build("anthropic", "stub-model", "stub-key");
		await turn(agent);
		expect(seen[0]?.tokens).toBe(0);
	}, 60_000);
});
