/**
 * Cache-aware failover affinity (#4500): the pitch's success metric as a script.
 *
 * Replays a 20-turn session through the shipping Agent.chat() turn loop against
 * stub providers, with one injected 5xx burst on the warm backend at turn 10,
 * and prints the prefill tokens re-sent with EIGHT_CACHE_AFFINITY on versus off.
 *
 * The stubs model a prefix cache per backend: a request prefills only the part
 * of its prompt the backend has not already seen, then the backend holds the
 * whole prompt. The prompt grows by PROMPT_STEP tokens per turn. "Prefill
 * tokens" is the sum of what each request made a backend compute. The numbers
 * come from the stub's model of a prefix cache, not from a real GPU.
 *
 * Run: bun run scripts/affinity-replay.ts
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TURNS = 20;
const FAIL_TURN = 10;
const PROMPT_STEP = 2000;
/** Consecutive 5xx the warm backend returns: one provider-client attempt (initial + its own retries). */
const BURST = Number(process.env.AFFINITY_REPLAY_BURST ?? 3);

type Backend = "ollama" | "openrouter";

const home = mkdtempSync(join(tmpdir(), "affreplay-home-"));
const repo = mkdtempSync(join(tmpdir(), "affreplay-repo-"));
mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
Object.assign(process.env, {
	HOME: home,
	EIGHT_DATA_DIR: join(home, ".8gent"),
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "60000",
	OPENROUTER_API_KEY: "sk-or-replay",
	EIGHT_ALLOW_HOSTED: "1",
});

let turn = 0;
let failLeft = 0;
let prefill = 0;
let requests = 0;
const cache: Record<Backend, number> = { ollama: 0, openrouter: 0 };

function stub(name: Backend): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			requests++;
			if (name === "ollama" && failLeft > 0) {
				failLeft--;
				return new Response(JSON.stringify({ error: { message: "503 upstream" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			}
			const prompt = turn * PROMPT_STEP;
			prefill += Math.max(0, prompt - cache[name]);
			cache[name] = prompt;
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [
					{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
				],
				usage: { prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1 },
			});
		},
	});
}

const ollama = stub("ollama");
const openrouter = stub("openrouter");
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname === "openrouter.ai") {
		return realFetch(
			`http://127.0.0.1:${openrouter.port}${url.pathname.replace(/^\/api/, "")}${url.search}`,
			init,
		);
	}
	return realFetch(input, init);
}) as typeof fetch;

const { ModelFailover } = await import("../packages/providers/failover");
(ModelFailover.prototype as unknown as { loadChains: () => unknown }).loadChains = () => ({
	text: {
		"replay-a": {
			models: [
				{ model: "replay-a", provider: "ollama" },
				{ model: "replay-b", provider: "openrouter" },
			],
		},
		"replay-b": { models: [{ model: "replay-b", provider: "openrouter" }] },
	},
	computer: {},
});
const { Agent } = await import("../packages/eight/agent");

async function run(
	affinity: boolean,
): Promise<{ prefill: number; requests: number; hops: number }> {
	process.env.EIGHT_CACHE_AFFINITY = affinity ? "1" : "0";
	prefill = 0;
	requests = 0;
	cache.ollama = 0;
	cache.openrouter = 0;
	let hops = 0;
	const agent = new Agent({
		model: "replay-a",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${ollama.port}`,
		events: { onModelRouted: () => hops++ },
	} as ConstructorParameters<typeof Agent>[0]);
	const log = console.log;
	console.log = () => {};
	try {
		for (turn = 1; turn <= TURNS; turn++) {
			failLeft = turn === FAIL_TURN ? BURST : 0;
			await agent.chat("say done");
		}
	} finally {
		console.log = log;
		await agent.cleanup();
	}
	return { prefill, requests, hops };
}

const off = await run(false);
const on = await run(true);
console.log(
	`turns=${TURNS} 5xx burst=${BURST} requests at turn ${FAIL_TURN}, prompt +${PROMPT_STEP} tokens/turn`,
);
console.log(
	`flag off: prefill tokens re-sent=${off.prefill} requests=${off.requests} hops=${off.hops}`,
);
console.log(
	`flag on : prefill tokens re-sent=${on.prefill} requests=${on.requests} hops=${on.hops}`,
);

ollama.stop(true);
openrouter.stop(true);
rmSync(home, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
process.exit(0);
