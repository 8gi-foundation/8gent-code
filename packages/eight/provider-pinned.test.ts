/**
 * #3746: a provider the user named is never left for another provider, and a
 * hosted provider with no key is never sent a request.
 *
 * Drives the shipping chat() native-tool path, as failover-provider-config.test
 * does: a fake session endpoint stands in for the named local provider, and
 * globalThis.fetch routes openrouter.ai to a second fake so the test can count
 * what the hosted provider would have received. Any other non-local host is
 * refused, so nothing reaches the real network. The failover chain is the
 * test's own (ModelFailover.loadChains is stubbed).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let Agent: typeof import("./agent").Agent;

interface Seen {
	server: "session" | "openrouter";
	model: string;
	auth: string | null;
}

const OR_KEY = "sk-or-env-3746";
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	OPENROUTER_API_KEY: OR_KEY,
};
let home: string;
let repo: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const seen: Seen[] = [];
let sessionPort = 0;
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

function fake(name: Seen["server"], fails: (model: string) => boolean): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			seen.push({ server: name, model: body.model, auth: req.headers.get("authorization") });
			if (fails(body.model)) {
				return new Response(JSON.stringify({ error: { message: `${name} refuses` } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return Response.json({
				id: "c1",
				object: "chat.completion",
				created: 0,
				model: body.model,
				choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		},
	});
	servers.push(s);
	return s;
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "pinned3746-home-"));
	repo = mkdtempSync(join(tmpdir(), "pinned3746-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });

	// The named provider is down for every model; the hosted one would answer.
	const session = fake("session", () => true);
	const openrouter = fake("openrouter", () => false);
	sessionPort = session.port ?? 0;

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
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
			// The named provider first, then the hosted tier, as the default chains end.
			"pin-a": {
				models: [
					{ model: "pin-a", provider: "ollama" },
					{ model: "or-a", provider: "openrouter" },
				],
			},
			// Same-provider failover stays allowed for a pinned session.
			"pin-b": {
				models: [
					{ model: "pin-b", provider: "ollama" },
					{ model: "pin-b2", provider: "ollama" },
					{ model: "or-b", provider: "openrouter" },
				],
			},
			// Hedge: resolve("hedge-h") names a sibling on the hosted provider.
			"hedge-h": { models: [{ model: "sib-h", provider: "openrouter" }] },
			"or-a": { models: [{ model: "or-a", provider: "openrouter" }] },
			"pin-b2": { models: [{ model: "pin-b2", provider: "ollama" }] },
			"or-b": { models: [{ model: "or-b", provider: "openrouter" }] },
			"sib-h": { models: [{ model: "sib-h", provider: "openrouter" }] },
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

afterAll(() => {
	fetchSpy?.mockRestore();
	chainSpy?.mockRestore();
	for (const s of servers) s.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

async function turn(
	model: string,
	opts: { pinned?: boolean; prep?: (agent: import("./agent").Agent) => void } = {},
): Promise<{ reqs: Seen[]; error: string }> {
	const start = seen.length;
	const agent = new Agent({
		model,
		runtime: "ollama",
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
		providerPinned: opts.pinned,
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
	opts.prep?.(agent);
	let error = "";
	try {
		const out = await agent.chat("say done");
		error = String(out ?? "");
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { reqs: seen.slice(start), error };
}

describe("a named provider never falls back to another provider (#3746)", () => {
	test("pinned: the hosted provider receives nothing and the error is plain", async () => {
		const { reqs, error } = await turn("pin-a", { pinned: true });
		expect(reqs.filter((r) => r.server === "session").length).toBeGreaterThan(0);
		expect(reqs.filter((r) => r.server === "openrouter")).toEqual([]);
		expect(error).toContain("ollama/pin-a failed");
		expect(error).toContain("no other provider was tried");
	}, 30000);

	test("pinned: another model on the same provider is still tried", async () => {
		const { reqs } = await turn("pin-b", { pinned: true });
		const models = reqs.map((r) => r.model);
		expect(models).toContain("pin-b");
		expect(models).toContain("pin-b2");
		expect(reqs.filter((r) => r.server === "openrouter")).toEqual([]);
	}, 30000);

	test("pinned: the hedge sends no sibling to another provider", async () => {
		const { DEFAULT_HEDGE_CONFIG, HedgeExecutor } = await import("../kernel/hedge-executor");
		const { reqs } = await turn("hedge-h", {
			pinned: true,
			prep: (agent) => {
				(agent as unknown as { kernel: { hedgeExecutor: unknown } }).kernel.hedgeExecutor =
					new HedgeExecutor({
						...DEFAULT_HEDGE_CONFIG,
						enabled: true,
						signalPath: join(home, "hedge-signal.jsonl"),
					});
			},
		});
		expect(reqs.filter((r) => r.server === "openrouter")).toEqual([]);
	}, 30000);

	test("not pinned: the adaptive router still fails over as before", async () => {
		const { reqs } = await turn("pin-a");
		const or = reqs.filter((r) => r.server === "openrouter");
		expect(or.map((r) => r.model)).toContain("or-a");
		for (const r of or) expect(r.auth).toBe(`Bearer ${OR_KEY}`);
	}, 30000);

	test("not pinned, no key: the hosted provider receives nothing", async () => {
		const prev = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			const { reqs, error } = await turn("pin-a");
			expect(reqs.filter((r) => r.server === "openrouter")).toEqual([]);
			expect(error).toContain("No API key for openrouter");
		} finally {
			process.env.OPENROUTER_API_KEY = prev;
		}
	}, 30000);
});

describe("hosted providers need a key before any request (#3746)", () => {
	test("hostedWithoutKey: hosted with no key, never local or keyed", async () => {
		const { hostedWithoutKey } = await import("../ai/providers");
		expect(hostedWithoutKey("openrouter", "https://openrouter.ai/api/v1", undefined)).toBe(true);
		expect(hostedWithoutKey("openrouter", "https://openrouter.ai/api/v1", "")).toBe(true);
		// A key of only spaces is no key.
		expect(hostedWithoutKey("openrouter", "https://openrouter.ai/api/v1", "   ")).toBe(true);
		expect(hostedWithoutKey("openrouter", "https://openrouter.ai/api/v1", "k")).toBe(false);
		expect(hostedWithoutKey("openrouter", "http://127.0.0.1:9/v1", undefined)).toBe(false);
		expect(hostedWithoutKey("ollama", "http://gpu-box.lan:11434/v1", undefined)).toBe(false);
		expect(hostedWithoutKey("llama-server", "http://10.0.0.5:8080/v1", undefined)).toBe(false);
	});

	test("createModel with no key sends nothing", async () => {
		const prev = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
		try {
			const { createModel } = await import("../ai/providers");
			const model = createModel({ name: "openrouter", model: "m" }) as unknown as {
				doGenerate: (o: unknown) => Promise<unknown>;
			};
			let msg = "";
			try {
				await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
			} catch (e) {
				msg = String((e as Error)?.message ?? e);
			}
			expect(msg).toContain("No API key for openrouter");
			const after = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
			expect(after).toBe(before);
		} finally {
			process.env.OPENROUTER_API_KEY = prev;
		}
	});

	test("OpenRouterClient with no key sends nothing", async () => {
		const { OpenRouterClient } = await import("./clients/openrouter");
		const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
		const client = new OpenRouterClient("m", "");
		expect(await client.isAvailable()).toBe(false);
		expect(await new OpenRouterClient("m", "  ").isAvailable()).toBe(false);
		await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow("No API key for openrouter");
		const after = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
		expect(after).toBe(before);
	});
});

describe("mayMoveToProvider", () => {
	test("pinned stays on its provider; un-pinned goes anywhere", async () => {
		const { mayMoveToProvider } = await import("./failover-provider-config");
		expect(mayMoveToProvider(true, "ollama", "ollama")).toBe(true);
		expect(mayMoveToProvider(true, "ollama", "openrouter")).toBe(false);
		expect(mayMoveToProvider(false, "ollama", "openrouter")).toBe(true);
		expect(mayMoveToProvider(undefined, "ollama", "openrouter")).toBe(true);
	});
});
