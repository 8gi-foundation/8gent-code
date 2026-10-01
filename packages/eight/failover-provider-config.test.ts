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
	server: "session" | "ollamaDefault";
	path: string;
	model: string;
	auth: string | null;
}

const SESSION_KEY = "sk-session-3261";

const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
};
let home: string;
let repo: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const seen: Seen[] = [];
let sessionPort = 0;

/** Models each endpoint rejects with a non-rate-limit 500, so the chain advances. */
const FAILING: Record<Seen["server"], Set<string>> = {
	session: new Set(["primary-a", "primary-b"]),
	ollamaDefault: new Set(["primary-a", "backup-a", "primary-b"]),
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
	sessionPort = session.port ?? 0;

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
			"backup-a": { models: [{ model: "backup-a", provider: "ollama" }] },
			"other-b": { models: [{ model: "other-b", provider: "ollama" }] },
		},
		computer: {},
	};
	const { ModelFailover } = await import("../providers/failover");
	spyOn(
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
	for (const s of servers) s.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

async function turn(runtime: "ollama" | "lmstudio", model: string): Promise<Seen[]> {
	const start = seen.length;
	const agent = new Agent({
		model,
		runtime,
		workingDirectory: repo,
		baseUrl: `http://127.0.0.1:${sessionPort}`,
		apiKey: SESSION_KEY,
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
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
