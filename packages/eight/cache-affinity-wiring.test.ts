/**
 * #4500: cache-aware failover affinity is wired into the shipping chat() path.
 *
 * Drives the real native-tool turn loop as provider-pinned.test.ts does: a fake
 * session endpoint (provider ollama) and a fake openrouter. The chain is the
 * test's own. With the flag on, a session that failed over keeps the backend
 * that now holds its prompt, a transient error on that backend gets one grace
 * retry, and cleanup() forgets the session. With the flag off the turn path is
 * the one that shipped before: the same requests and the same route events.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";

let Agent: typeof import("./agent").Agent;

type Server = "session" | "openrouter";
const seen: Server[] = [];
/** Next status for the session endpoint, per request; empty means 200. */
let sessionScript: number[] = [];
let sessionAlways: number | null = null;
const PROMPT_TOKENS = 50_000;

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	OPENROUTER_API_KEY: "sk-or-env-4500",
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
let sessionPort = 0;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

function fake(name: Server): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			seen.push(name);
			const status = name === "session" ? (sessionScript.shift() ?? sessionAlways ?? 200) : 200;
			if (status !== 200) {
				return new Response(JSON.stringify({ error: { message: `${status} upstream` } }), {
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
				usage: {
					prompt_tokens: PROMPT_TOKENS,
					completion_tokens: 1,
					total_tokens: PROMPT_TOKENS + 1,
				},
			});
		},
	});
	servers.push(s);
	return s;
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "aff4500-home-"));
	repo = mkdtempSync(join(tmpdir(), "aff4500-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	const session = fake("session");
	const openrouter = fake("openrouter");
	sessionPort = session.port ?? 0;

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "openrouter.ai") {
			const path = url.pathname.replace(/^\/api/, "");
			return realFetch(`http://127.0.0.1:${openrouter.port}${path}${url.search}`, init);
		}
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
			return Promise.reject(new Error(`test blocks network to ${url.hostname}`));
		}
		return realFetch(input, init);
	}) as typeof fetch);

	const chains = {
		text: {
			"aff-a": {
				models: [
					{ model: "aff-a", provider: "ollama" },
					{ model: "or-a", provider: "openrouter" },
				],
			},
			"or-a": { models: [{ model: "or-a", provider: "openrouter" }] },
		},
		computer: {},
	};
	const { ModelFailover } = await import("../providers/failover");
	chainSpy = spyOn(
		ModelFailover.prototype as unknown as { loadChains: () => unknown },
		"loadChains",
	).mockReturnValue(chains);

	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterEach(() => {
	Reflect.deleteProperty(process.env, "EIGHT_CACHE_AFFINITY");
	sessionScript = [];
	sessionAlways = null;
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

interface Routed {
	requested: string;
	used: string;
	provider: string;
}

/** One agent, several turns; returns the backend of every request and the route events. */
async function session(
	turns: Array<{ script?: number[] }>,
): Promise<{ served: Server[]; routed: Routed[]; agent: InstanceType<typeof Agent> }> {
	const routed: Routed[] = [];
	const agent = new Agent({
		model: "aff-a",
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
		events: { onModelRouted: (e: Routed) => routed.push(e) },
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
	const start = seen.length;
	for (const t of turns) {
		sessionScript = [...(t.script ?? [])];
		await agent.chat("say done");
	}
	return { served: seen.slice(start), routed, agent };
}

const internals = (a: unknown) =>
	a as {
		affinityFailover: { affinitySize: number } | null;
		sessionId: string;
	};

describe("cache affinity is wired into the turn loop (#4500)", () => {
	test("flag off: the turn path is the one that shipped", async () => {
		// Session fails on turn 1 and recovers; with no affinity turn 2 returns to the head.
		const off = await session([{ script: [500, 500, 500, 500, 500, 500] }, {}]);
		expect(off.served[0]).toBe("session");
		expect(off.served.at(-1)).toBe("session");
		expect(off.served).toContain("openrouter");
		// Only turn 1 announced a hop; turn 2 stayed on the requested model.
		expect(off.routed).toEqual([{ requested: "aff-a", used: "or-a", provider: "openrouter" }]);
		expect(internals(off.agent).affinityFailover).toBeNull();

		// A second flag-off run, explicitly "0", is identical request for request.
		process.env.EIGHT_CACHE_AFFINITY = "0";
		const zero = await session([{ script: [500, 500, 500, 500, 500, 500] }, {}]);
		expect(zero.served).toEqual(off.served);
		expect(zero.routed).toEqual(off.routed);
	}, 60000);

	test("flag on: the turn after a failover starts on the backend that holds the prompt", async () => {
		process.env.EIGHT_CACHE_AFFINITY = "1";
		const on = await session([{ script: [500, 500, 500, 500, 500, 500] }, {}]);
		const firstOr = on.served.indexOf("openrouter");
		expect(firstOr).toBeGreaterThan(0);
		// Turn 2 sent nothing to the recovered session endpoint.
		expect(on.served.slice(firstOr).every((s) => s === "openrouter")).toBe(true);
		expect(internals(on.agent).affinityFailover?.affinitySize).toBe(1);
	}, 60000);

	test("flag on: a transient error on the warm backend gets one grace retry before the hop", async () => {
		const logs: string[] = [];
		const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.join(" "));
		});
		try {
			// Turn 1 warms the session endpoint (50k prompt tokens); turn 2 is down for good.
			process.env.EIGHT_CACHE_AFFINITY = "1";
			sessionAlways = null;
			const on = await session([{}, { script: Array(40).fill(503) }]);
			expect(logs.filter((l) => l.includes("grace retry"))).toHaveLength(1);
			// The grace was one retry, not a stay: the turn still ended on openrouter.
			expect(on.served).toContain("openrouter");

			logs.length = 0;
			process.env.EIGHT_CACHE_AFFINITY = "0";
			const off = await session([{}, { script: Array(40).fill(503) }]);
			expect(logs.filter((l) => l.includes("grace retry"))).toEqual([]);
			expect(off.served).toContain("openrouter");
		} finally {
			logSpy.mockRestore();
		}
	}, 90000);

	test("cleanup forgets the session", async () => {
		process.env.EIGHT_CACHE_AFFINITY = "1";
		const on = await session([{ script: [500, 500, 500, 500, 500, 500] }]);
		const fo = internals(on.agent).affinityFailover;
		expect(fo?.affinitySize).toBe(1);
		await on.agent.cleanup();
		expect(fo?.affinitySize).toBe(0);
	}, 60000);
});
