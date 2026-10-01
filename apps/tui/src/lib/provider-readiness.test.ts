/**
 * Provider readiness gate - real sockets, no fetch stubs.
 *
 * The silent stub reproduces the 2026-09-28 fault exactly: a TCP listener that
 * accepts the connection and never writes a byte (LM Studio hung on :1234).
 * Before this gate the agent init awaited that forever.
 */

import type { TCPSocketListener } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createReadinessCache,
	type LocalProviderEndpoint,
	localProviderEndpoints,
	probeModels,
	resolveReadyProvider,
	withTimeout,
} from "./provider-readiness.js";

let silent: TCPSocketListener<undefined>;
let empty: ReturnType<typeof Bun.serve>;
let emptyUrl = "";
let healthy: ReturnType<typeof Bun.serve>;
let silentUrl = "";
let healthyUrl = "";
// A port nothing listens on: bind, read the port, close.
let deadUrl = "";

beforeAll(() => {
	silent = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {}, open() {} },
	});
	silentUrl = `http://127.0.0.1:${silent.port}`;
	healthy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/api/tags") {
				return Response.json({
					models: [{ name: "nomic-embed-text:latest" }, { name: "qwen3:14b" }],
				});
			}
			return new Response("nope", { status: 404 });
		},
	});
	healthyUrl = `http://127.0.0.1:${healthy.port}`;
	// A fresh Ollama before any `ollama pull`: answers, lists nothing.
	empty = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ models: [] }) });
	emptyUrl = `http://127.0.0.1:${empty.port}`;
	const tmp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	deadUrl = `http://127.0.0.1:${tmp.port}`;
	tmp.stop(true);
});

afterAll(() => {
	silent.stop(true);
	healthy.stop(true);
	empty.stop(true);
});

const ollamaExtract = (d: any) => (d?.models || []).map((m: any) => String(m?.name ?? ""));
const lmExtract = (d: any) => (d?.data || []).map((m: any) => String(m?.id ?? ""));

function endpoints(lmBase: string, ollamaBase: string): LocalProviderEndpoint[] {
	return [
		{ provider: "lmstudio", label: "LM Studio", modelsUrl: `${lmBase}/v1/models`, extract: lmExtract },
		{ provider: "ollama", label: "Ollama", modelsUrl: `${ollamaBase}/api/tags`, extract: ollamaExtract },
	];
}

describe("probeModels", () => {
	test("a port that accepts TCP but never answers is DOWN within the bound", async () => {
		const t0 = Date.now();
		const r = await probeModels(`${silentUrl}/v1/models`, lmExtract, 300);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("no answer within 0.3s");
		expect(Date.now() - t0).toBeLessThan(2000);
	}, 4000);

	test("a healthy server returns its model list", async () => {
		const r = await probeModels(`${healthyUrl}/api/tags`, ollamaExtract, 1000);
		expect(r).toEqual({ ok: true, models: ["nomic-embed-text:latest", "qwen3:14b"] });
	});

	test("nothing listening is DOWN, reported as not reachable", async () => {
		const r = await probeModels(`${deadUrl}/v1/models`, lmExtract, 1000);
		expect(r).toEqual({ ok: false, reason: "not reachable" });
	});

	test("a non-2xx is DOWN, reporting the status", async () => {
		const r = await probeModels(`${healthyUrl}/v1/models`, lmExtract, 1000);
		expect(r).toEqual({ ok: false, reason: "http 404" });
	});
});

describe("resolveReadyProvider", () => {
	test("the live fault: LM Studio hung, Ollama healthy -> falls back to Ollama and says so", async () => {
		const t0 = Date.now();
		const d = await resolveReadyProvider(
			{ provider: "lmstudio", model: "ornith-1.0-9b" },
			{ timeoutMs: 300, endpoints: endpoints(silentUrl, healthyUrl) },
		);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(d.kind).toBe("fallback");
		if (d.kind !== "fallback") return;
		expect(d.provider).toBe("ollama");
		// Embedding model skipped; a chat model is chosen.
		expect(d.model).toBe("qwen3:14b");
		expect(d.from).toBe("lmstudio");
		expect(d.notice).toContain("LM Studio is unreachable");
		expect(d.notice).toContain("Using Ollama (qwen3:14b)");
		expect(d.notice.includes("\n")).toBe(false);
	}, 4000);

	test("configured provider healthy -> kept as is, no fallback", async () => {
		const d = await resolveReadyProvider(
			{ provider: "ollama", model: "my-model" },
			{ timeoutMs: 1000, endpoints: endpoints(silentUrl, healthyUrl) },
		);
		expect(d).toEqual({ kind: "ready", provider: "ollama", model: "my-model" });
	});

	test("nothing healthy -> a clear error naming /provider, within the bound", async () => {
		const t0 = Date.now();
		const d = await resolveReadyProvider(
			{ provider: "lmstudio", model: "ornith-1.0-9b" },
			{ timeoutMs: 300, endpoints: endpoints(silentUrl, deadUrl) },
		);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(d.kind).toBe("none");
		if (d.kind === "none") expect(d.notice).toContain("/provider");
	}, 4000);

	test("engine answers but lists no models -> not ready, says so, names the address (T5)", async () => {
		const d = await resolveReadyProvider(
			{ provider: "ollama", model: "qwen3.5:latest" },
			{ timeoutMs: 1000, endpoints: endpoints(deadUrl, emptyUrl) },
		);
		expect(d.kind).toBe("none");
		if (d.kind === "none") {
			expect(d.reason).toBe("no models");
			expect(d.fromAddress).toBe(emptyUrl.replace("http://", ""));
			expect(d.notice).toContain("Ollama has no models");
		}
	});

	test("engine with no models falls back to one that has them", async () => {
		const d = await resolveReadyProvider(
			{ provider: "lmstudio", model: "" },
			{
				timeoutMs: 1000,
				endpoints: [
					{ provider: "lmstudio", label: "LM Studio", modelsUrl: `${emptyUrl}/api/tags`, extract: ollamaExtract },
					{ provider: "ollama", label: "Ollama", modelsUrl: `${healthyUrl}/api/tags`, extract: ollamaExtract },
				],
			},
		);
		expect(d.kind).toBe("fallback");
		if (d.kind === "fallback") expect(d.notice).toContain("LM Studio has no models. Using Ollama");
	});

	test("non-local providers are not probed", async () => {
		const d = await resolveReadyProvider(
			{ provider: "openrouter", model: "auto:free" },
			{ timeoutMs: 300, endpoints: endpoints(silentUrl, deadUrl) },
		);
		expect(d).toEqual({ kind: "ready", provider: "openrouter", model: "auto:free" });
	});
});

describe("createReadinessCache", () => {
	test("concurrent callers share one probe (the init effect re-runs many times a second)", async () => {
		let calls = 0;
		const cache = createReadinessCache(10_000, async (want) => {
			calls++;
			await Bun.sleep(50);
			return { kind: "ready", provider: want.provider, model: want.model };
		});
		const want = { provider: "lmstudio", model: "m" };
		const [a, b, c] = await Promise.all([cache(want), cache(want), cache(want)]);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
		expect(b).toEqual(c);
	});

	test("a settled result expires after the TTL so a recovered provider is re-probed", async () => {
		let calls = 0;
		let clock = 0;
		const cache = createReadinessCache(
			1000,
			async (want) => {
				calls++;
				return { kind: "ready", provider: want.provider, model: want.model };
			},
			() => clock,
		);
		const want = { provider: "lmstudio", model: "m" };
		await cache(want);
		clock = 500;
		await cache(want);
		expect(calls).toBe(1);
		clock = 1600;
		await cache(want);
		expect(calls).toBe(2);
	});
});

describe("withTimeout", () => {
	test("a promise that never settles resolves to the fallback", async () => {
		const never = new Promise<boolean>(() => {});
		expect(await withTimeout(never, 50, false)).toBe(false);
	});

	test("a settled promise wins", async () => {
		expect(await withTimeout(Promise.resolve(true), 1000, false)).toBe(true);
	});
});

describe("localProviderEndpoints (#3115)", () => {
	const ollamaUrl = (env: Record<string, string | undefined>) =>
		localProviderEndpoints(env).find((e) => e.provider === "ollama")?.modelsUrl;

	test("a bare host:port OLLAMA_HOST, as the ollama CLI takes it, becomes a real URL", () => {
		expect(ollamaUrl({ OLLAMA_HOST: "10.0.0.5:11434" })).toBe("http://10.0.0.5:11434/api/tags");
	});

	test("OLLAMA_BASE_URL wins, as everywhere else in the app", () => {
		expect(ollamaUrl({ OLLAMA_BASE_URL: "http://gpu:11434/v1", OLLAMA_HOST: "other:1" })).toBe(
			"http://gpu:11434/api/tags",
		);
	});

	test("nothing set is localhost", () => {
		expect(ollamaUrl({})).toBe("http://localhost:11434/api/tags");
	});
});
