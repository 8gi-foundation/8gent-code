/**
 * #3261: native failover keeps the right endpoint and key for each provider.
 *
 * Drives the shipping chat() native-tool path against fake OpenAI-compatible
 * endpoints and asserts on what each one received: the URL it was sent to (by
 * which server got it) and the Authorization header.
 *
 * - session: the endpoint this session pinned (AgentConfig.baseUrl), keyed
 *   with the session's apiKey.
 * - ollamaDefault: ollama's own default endpoint (OLLAMA_BASE_URL, resolved at
 *   call time). For an ollama session a request landing here means the
 *   session's baseURL was dropped. For a failover INTO ollama from another
 *   provider it is the right endpoint, and it must arrive without the
 *   session's key (ollama takes none).
 * - openrouter: stands in for https://openrouter.ai. globalThis.fetch is
 *   wrapped so openrouter.ai requests land here, and any other non-local host
 *   is refused, so the test can never reach the real network.
 *
 * The failover chain is the test's own (ModelFailover's loader is stubbed: Bun's
 * os.homedir() ignores a runtime $HOME, so a fake failover.json would not be
 * read). Every model the chain reaches has a chain of its own, so an exhausted
 * chain ends the turn instead of falling through to the real openrouter.
 * $HOME is still faked so the operator's memories and sessions stay out.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let Agent: typeof import("./agent").Agent;

interface Seen {
	server: "session" | "ollamaDefault" | "openrouter";
	path: string;
	model: string;
	auth: string | null;
}

const SESSION_KEY = "sk-session-3261";
/** OPENROUTER_API_KEY in the env, the way the TUI and daemon have it. */
const OR_KEY = "sk-or-env-3261";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	OPENROUTER_API_KEY: OR_KEY,
	// These walk chains into hosted providers, which are opt-in (#3710).
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const seen: Seen[] = [];
let sessionPort = 0;
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

/** Models each endpoint rejects with a non-rate-limit 500, so the chain advances. */
const FAILING: Record<Seen["server"], Set<string>> = {
	session: new Set(["primary-a", "primary-b", "primary-c", "primary-d"]),
	ollamaDefault: new Set([
		"primary-a",
		"backup-a",
		"primary-b",
		"primary-c",
		"primary-d",
		"backup-d",
	]),
	openrouter: new Set(),
};

function fake(name: Seen["server"]): ReturnType<typeof Bun.serve> {
	const s = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ models: [], data: [] });
			const body = (await req.json()) as { model: string };
			seen.push({
				server: name,
				path: new URL(req.url).pathname,
				model: body.model,
				auth: req.headers.get("authorization"),
			});
			if (FAILING[name].has(body.model)) {
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
	home = mkdtempSync(join(tmpdir(), "failover3261-home-"));
	repo = mkdtempSync(join(tmpdir(), "failover3261-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });

	const session = fake("session");
	const ollamaDefault = fake("ollamaDefault");
	const openrouter = fake("openrouter");
	sessionPort = session.port ?? 0;

	// openrouter.ai goes to the fake; any other non-local host is refused.
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
			// Same-provider failover: both legs belong to the session's provider.
			"primary-a": {
				models: [
					{ model: "primary-a", provider: "ollama" },
					{ model: "backup-a", provider: "ollama" },
				],
			},
			// Cross-provider failover: an lmstudio session fails over to ollama.
			"primary-b": {
				models: [
					{ model: "primary-b", provider: "lmstudio" },
					{ model: "other-b", provider: "ollama" },
				],
			},
			// Cross-provider failover into a provider that needs its own env key.
			"primary-c": {
				models: [
					{ model: "primary-c", provider: "ollama" },
					{ model: "or-c", provider: "openrouter" },
				],
			},
			// TUI-style session: same-provider failover with no key of its own.
			"primary-d": {
				models: [
					{ model: "primary-d", provider: "ollama" },
					{ model: "backup-d", provider: "ollama" },
				],
			},
			// Hedge: resolve("hedge-h") names a sibling on another provider.
			"hedge-h": { models: [{ model: "sib-h", provider: "openrouter" }] },
			"backup-a": { models: [{ model: "backup-a", provider: "ollama" }] },
			"other-b": { models: [{ model: "other-b", provider: "ollama" }] },
			"or-c": { models: [{ model: "or-c", provider: "openrouter" }] },
			"backup-d": { models: [{ model: "backup-d", provider: "ollama" }] },
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
	ENV.OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaDefault.port}`;
	ENV.OLLAMA_HOST = `http://127.0.0.1:${ollamaDefault.port}`;
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	// Bun shares globals and modules across test files: put both back.
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
	runtime: "ollama" | "lmstudio",
	model: string,
	opts: { apiKey?: string; prep?: (agent: import("./agent").Agent) => void } = {
		apiKey: SESSION_KEY,
	},
): Promise<Seen[]> {
	const start = seen.length;
	const agent = new Agent({
		model,
		runtime,
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
		apiKey: opts.apiKey,
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
	opts.prep?.(agent);
	try {
		await agent.chat("say done");
	} catch {
		// An exhausted chain throws; the requests it made are what we assert on.
	}
	return seen.slice(start);
}

describe("native failover provider config (#3261)", () => {
	test("same-provider failover keeps the session baseURL and key on every leg", async () => {
		const reqs = await turn("ollama", "primary-a");
		const models = reqs.map((r) => r.model);
		expect(models).toContain("primary-a");
		expect(models).toContain("backup-a");

		// Nothing went to the provider's default endpoint.
		expect(reqs.filter((r) => r.server === "ollamaDefault")).toEqual([]);
		for (const r of reqs) {
			expect(r.server).toBe("session");
			expect(r.path).toBe("/v1/chat/completions");
			expect(r.auth).toBe(`Bearer ${SESSION_KEY}`);
		}
	}, 30000);

	test("cross-provider failover uses that provider's own endpoint and key, never the session's", async () => {
		const reqs = await turn("lmstudio", "primary-b");

		const first = reqs.filter((r) => r.model === "primary-b");
		expect(first.length).toBeGreaterThan(0);
		for (const r of first) {
			expect(r.server).toBe("session");
			expect(r.auth).toBe(`Bearer ${SESSION_KEY}`);
		}

		const other = reqs.filter((r) => r.model === "other-b");
		expect(other.length).toBeGreaterThan(0);
		for (const r of other) {
			expect(r.server).toBe("ollamaDefault");
			expect(r.path).toBe("/v1/chat/completions");
			// ollama resolves its own key, which is none.
			expect(r.auth).toBeNull();
		}

		// The session's key never left for another provider's host.
		const leaked = seen.filter((r) => r.server !== "session" && r.auth?.includes(SESSION_KEY));
		expect(leaked).toEqual([]);
	}, 30000);

	test("cross-provider failover into openrouter applies openrouter's own env key", async () => {
		const reqs = await turn("ollama", "primary-c");
		const or = reqs.filter((r) => r.model === "or-c");
		expect(or.length).toBeGreaterThan(0);
		for (const r of or) {
			expect(r.server).toBe("openrouter");
			expect(r.path).toBe("/v1/chat/completions");
			expect(r.auth).toBe(`Bearer ${OR_KEY}`);
		}
		const leaked = seen.filter((r) => r.server !== "session" && r.auth?.includes(SESSION_KEY));
		expect(leaked).toEqual([]);
	}, 30000);

	test("TUI-style ollama session with an OpenRouter env key sends that key to no ollama host", async () => {
		const { sessionApiKey } = await import("./failover-provider-config");
		// Exactly what the TUI and daemon hosts now build for an ollama runtime.
		const reqs = await turn("ollama", "primary-d", { apiKey: sessionApiKey("ollama") });
		const models = reqs.map((r) => r.model);
		expect(models).toContain("primary-d"); // step 0
		expect(models).toContain("backup-d"); // the failover leg
		for (const r of reqs) {
			expect(r.server).toBe("session");
			expect(r.auth).toBeNull();
		}
		const leaked = seen.filter((r) => r.server !== "openrouter" && r.auth?.includes(OR_KEY));
		expect(leaked).toEqual([]);
	}, 30000);

	test("hedge path: each candidate gets its own provider's endpoint and key", async () => {
		const { DEFAULT_HEDGE_CONFIG, HedgeExecutor } = await import("../kernel/hedge-executor");
		const reqs = await turn("ollama", "hedge-h", {
			apiKey: SESSION_KEY,
			prep: (agent) => {
				(agent as unknown as { kernel: { hedgeExecutor: unknown } }).kernel.hedgeExecutor =
					new HedgeExecutor({
						...DEFAULT_HEDGE_CONFIG,
						enabled: true,
						signalPath: join(home, "hedge-signal.jsonl"),
					});
			},
		});
		const head = reqs.filter((r) => r.model === "hedge-h");
		const sib = reqs.filter((r) => r.model === "sib-h");
		expect(head.length).toBeGreaterThan(0);
		expect(sib.length).toBeGreaterThan(0);
		for (const r of head) {
			expect(r.server).toBe("session");
			expect(r.auth).toBe(`Bearer ${SESSION_KEY}`);
		}
		for (const r of sib) {
			expect(r.server).toBe("openrouter");
			expect(r.auth).toBe(`Bearer ${OR_KEY}`);
		}
	}, 30000);
});

describe("sessionApiKey", () => {
	test("only an openrouter runtime gets the OpenRouter env key", async () => {
		const { sessionApiKey } = await import("./failover-provider-config");
		const env = { OPENROUTER_API_KEY: "k" };
		expect(sessionApiKey("openrouter", env)).toBe("k");
		for (const rt of ["ollama", "lmstudio", "apfel", "llama-server", "anthropic", "deepseek"]) {
			expect(sessionApiKey(rt, env)).toBeUndefined();
		}
		expect(sessionApiKey("openrouter", {})).toBeUndefined();
	});

	test("no source passes the OpenRouter env key as an apiKey whatever the runtime", async () => {
		const { readFileSync } = await import("node:fs");
		const root = join(import.meta.dir, "..", "..");
		// Every host, now and future: an AgentConfig (or pool config) built with
		// the OpenRouter env key sends it to whatever runtime the session runs.
		const pattern = /apiKey:\s*process\.env\.OPENROUTER_API_KEY/;
		const hits: string[] = [];
		for (const dir of ["apps", "packages", "bin"]) {
			for (const f of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })) {
				if (f.includes("node_modules") || /\.test\.tsx?$/.test(f)) continue;
				if (pattern.test(readFileSync(join(root, f), "utf8"))) hits.push(f);
			}
		}
		expect(hits).toEqual([]);
	});
});

describe("providerConfigForStep", () => {
	test("same provider keeps the session endpoint, key and headers, swaps the model", async () => {
		const { providerConfigForStep } = await import("./failover-provider-config");
		const session = {
			name: "openrouter" as const,
			model: "a",
			baseURL: "https://proxy.example/v1",
			apiKey: "k1",
			headers: { "x-h": "1" },
		};
		expect(providerConfigForStep(session, { provider: "openrouter", model: "b" })).toEqual({
			...session,
			model: "b",
		});
	});

	test("another provider gets none of the session's endpoint, key or headers", async () => {
		const { providerConfigForStep } = await import("./failover-provider-config");
		const session = {
			name: "openrouter" as const,
			model: "a",
			baseURL: "https://proxy.example/v1",
			apiKey: "k1",
			headers: { authorization: "Bearer k1" },
		};
		expect(providerConfigForStep(session, { provider: "ollama", model: "q" })).toEqual({
			name: "ollama",
			model: "q",
		});
	});
});
