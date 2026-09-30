/**
 * Characterisation of every /api/tags call site moved behind the local model
 * server layer in phase 1.
 *
 * Each call site runs against a real HTTP fake (Bun.serve) in seven scenarios.
 * The snapshot records the exact requests the fake received (method, path,
 * headers, body) and what the call site returned. The snapshot was written
 * from the code BEFORE the move and committed first; the move must leave it
 * byte-identical. A diff here is a behaviour change, not a snapshot to update.
 *
 * Normalised so it is stable across machines and Bun versions: the fake's
 * port, the refused port, runtime-owned header values (user-agent, host,
 * accept-encoding), and error messages that come
 * from the runtime rather than from our code.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchProviderModels } from "../../apps/tui/src/screens/OnboardingScreen";
import { probeProviders } from "../../apps/tui/src/lib/provider-health";
import { listOllamaModels } from "../decide/probe";
import { OllamaClient } from "../eight/clients/ollama";
import { detectOllama } from "../orchestration/local-model-detect";
import { SeleneJudge } from "../providers/local-judge";
import { probeOllama } from "../self-autonomy/onboarding";

type Scenario = "models" | "empty" | "no-models-key" | "models-not-list" | "http-500" | "bad-json" | "refused";
const SCENARIOS: Scenario[] = ["models", "empty", "no-models-key", "models-not-list", "http-500", "bad-json", "refused"];

const MODELS = {
	models: [
		{ name: "qwen3.8:27b-mlx", model: "qwen3.8:27b-mlx", size: 17_000_000_000, digest: "a1", details: { family: "qwen3" } },
		{ name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", size: 274_000_000, digest: "b2" },
		{ name: "llama3.2:3b", model: "llama3.2:3b", size: 2_000_000_000, digest: "c3" },
		{ name: "gemma3:4b", model: "gemma3:4b", size: 3_300_000_000, digest: "d4" },
		{ name: "eight-1.0-q3:14b", model: "eight-1.0-q3:14b", size: 9_000_000_000, digest: "e5" },
	],
};

/** Headers whose value the runtime owns (varies by Bun version or port), not the call site. */
const RUNTIME_HEADERS = new Set(["user-agent", "host", "accept-encoding"]);

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };
let scenario: Scenario = "models";
let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let fake = "";
let refused = "";

function respond(): Response {
	switch (scenario) {
		case "models":
			return Response.json(MODELS);
		case "empty":
			return Response.json({ models: [] });
		case "no-models-key":
			return Response.json({});
		case "models-not-list":
			return Response.json({ models: { name: "not-a-list" } });
		case "http-500":
			return new Response("boom", { status: 500 });
		case "bad-json":
			return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
		default:
			return new Response("unexpected", { status: 418 });
	}
}

beforeAll(async () => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const headers: Record<string, string> = {};
			for (const [k, v] of req.headers) headers[k] = RUNTIME_HEADERS.has(k) ? `<${k}>` : v;
			seen.push({ method: req.method, path: url.pathname + url.search, headers, body: await req.text() });
			// apfel and LM Studio legs of probeProviders are not Ollama: answer them 404.
			if (!url.pathname.startsWith("/api/tags")) return new Response("no", { status: 404 });
			return respond();
		},
	});
	fake = `http://127.0.0.1:${server.port}`;
	// A port that was just open and is now closed refuses the connection.
	const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	refused = `http://127.0.0.1:${closed.port}`;
	closed.stop(true);
});

afterAll(() => server.stop(true));

function base(): string {
	return scenario === "refused" ? refused : fake;
}

/** Run one call site under a scenario with the given env, then normalise what came back. */
async function capture(run: () => Promise<unknown>, env: Record<string, string | undefined> = {}): Promise<string> {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(env)) {
		saved[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	seen = [];
	let result: unknown;
	try {
		result = { returned: await run() };
	} catch (err) {
		const e = err as Error;
		// Our messages mention the endpoint; runtime messages (refused, JSON parse) vary by Bun version.
		result = { threw: e?.name, message: /api\/tags|answered HTTP/.test(e?.message ?? "") ? e.message : "<runtime>" };
	} finally {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
	const text = JSON.stringify({ requests: seen, result }, null, 2);
	return text.split(fake).join("<fake>").split(refused).join("<refused>");
}

const ollamaEnv = () => ({ OLLAMA_BASE_URL: base(), OLLAMA_HOST: undefined });

const CALL_SITES: Record<string, () => Promise<string>> = {
	"decide/probe listOllamaModels": () =>
		capture(() => listOllamaModels((i, init) => fetch(i, init), base(), 2000)),
	"self-autonomy/onboarding probeOllama": () =>
		capture(() => probeOllama({ env: { OLLAMA_BASE_URL: base() }, timeoutMs: 2000 })),
	"tui OnboardingScreen fetchProviderModels(ollama)": () =>
		capture(() => fetchProviderModels("ollama"), ollamaEnv()),
	"tui provider-health probeProviders": () =>
		capture(() => probeProviders(), { ...ollamaEnv(), APFEL_BASE_URL: fake, LM_STUDIO_HOST: fake }),
	"eight/clients OllamaClient.isAvailable": () => capture(() => new OllamaClient("m", base()).isAvailable()),
	"orchestration/local-model-detect detectOllama": () => capture(() => detectOllama(), ollamaEnv()),
	"providers/local-judge SeleneJudge.isAvailable": () =>
		capture(() => new SeleneJudge({ baseUrl: base() }).isAvailable()),
};

describe("phase 1 /api/tags call sites are unchanged by the local model server layer", () => {
	for (const [site, run] of Object.entries(CALL_SITES)) {
		for (const s of SCENARIOS) {
			test(`${site} :: ${s}`, async () => {
				scenario = s;
				expect(await run()).toMatchSnapshot();
			});
		}
	}
});

// TaskRouter.autoAssign writes ~/.8gent/router.json whenever it finds models, and
// resolves HOME at import. Run it in a child with a throwaway HOME so the test
// never touches the real config, and capture what it wrote as part of the result.
describe("phase 1 /api/tags call sites (subprocess)", () => {
	for (const s of SCENARIOS) {
		test(`ai/task-router TaskRouter.autoAssign :: ${s}`, async () => {
			scenario = s;
			const home = mkdtempSync(join(tmpdir(), "lms-home-"));
			try {
				const script = `
					import { TaskRouter } from ${JSON.stringify(join(import.meta.dir, "../ai/task-router.ts"))};
					import { existsSync, readFileSync } from "node:fs";
					const changes = await new TaskRouter().autoAssign();
					const p = process.env.HOME + "/.8gent/router.json";
					const saved = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
					process.stdout.write(JSON.stringify({ changes, saved: saved && { slots: saved.slots, classifierModel: saved.classifierModel, defaultModel: saved.defaultModel } }));
				`;
				seen = [];
				const child = Bun.spawn([process.execPath, "-e", script], {
					env: { PATH: process.env.PATH ?? "", HOME: home, OLLAMA_BASE_URL: base() },
					stdout: "pipe",
					stderr: "pipe",
				});
				const out = await new Response(child.stdout).text();
				await child.exited;
				const text = JSON.stringify({ requests: seen, result: JSON.parse(out) }, null, 2);
				expect(text.split(fake).join("<fake>").split(refused).join("<refused>")).toMatchSnapshot();
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});
