/**
 * The contract every LocalModelServer adapter must pass, against a real HTTP
 * fake speaking that server's dialect. Phase 1 runs it for Ollama; the
 * llama-server and LM Studio adapters run the same suite in their phases.
 *
 * Test-only: imported from *.test.ts files, never from runtime code.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type LocalFetch,
	type LocalModelServer,
	type LocalServerCapabilities,
	LocalServerHttpError,
	type LocalServerKind,
} from "./server";

export interface AdapterUnderTest {
	kind: LocalServerKind;
	create(baseUrl: string, fetch?: LocalFetch): LocalModelServer;
	/** Answer one request in this server's dialect, serving `models`. Return null for unknown paths. */
	answer(pathname: string, models: string[]): Response | null;
}

const CAPABILITY_KEYS: Array<keyof LocalServerCapabilities> = [
	"listModels",
	"pull",
	"multiModel",
	"mlx",
	"openaiChat",
	"rawPrompt",
	"embed",
	"modelInfo",
];

export function localModelServerContract(adapter: AdapterUnderTest): void {
	describe(`LocalModelServer contract: ${adapter.kind}`, () => {
		const MODELS = ["alpha:1b", "beta:7b"];
		let mode: "up" | "500" = "up";
		let seen: Array<{ method: string; url: string; body: string }> = [];
		let server: ReturnType<typeof Bun.serve>;
		let base = "";
		let refused = "";

		beforeAll(() => {
			server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(req) {
					const url = new URL(req.url);
					seen.push({ method: req.method, url: `${base}${url.pathname}`, body: await req.text() });
					if (mode === "500") return new Response("down", { status: 500 });
					return adapter.answer(url.pathname, MODELS) ?? new Response("unknown path", { status: 404 });
				},
			});
			base = `http://127.0.0.1:${server.port}`;
			const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
			refused = `http://127.0.0.1:${closed.port}`;
			closed.stop(true);
		});
		afterAll(() => server.stop(true));

		const fresh = (m: "up" | "500" = "up") => {
			mode = m;
			seen = [];
		};

		test("declares its kind and every capability as a frozen boolean", () => {
			const s = adapter.create(base);
			expect(s.kind).toBe(adapter.kind);
			expect(Object.keys(s.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
			for (const k of CAPABILITY_KEYS) expect(typeof s.capabilities[k]).toBe("boolean");
			expect(Object.isFrozen(s.capabilities)).toBe(true);
		});

		test("keeps the base URL verbatim and derives its URLs from it", () => {
			const s = adapter.create(base);
			expect(s.baseUrl).toBe(base);
			expect(s.modelsUrl.startsWith(base)).toBe(true);
			expect(s.healthUrl.startsWith(base)).toBe(true);
		});

		test("listModels returns the served models by name, in order, with one GET to modelsUrl", async () => {
			fresh();
			const s = adapter.create(base);
			const models = await s.listModels();
			expect(models.map((m) => m.name)).toEqual(MODELS);
			expect(seen).toEqual([{ method: "GET", url: s.modelsUrl, body: "" }]);
		});

		test("listModels rejects a non-2xx answer with LocalServerHttpError carrying the status", async () => {
			fresh("500");
			const err = await adapter
				.create(base)
				.listModels()
				.catch((e) => e);
			expect(err).toBeInstanceOf(LocalServerHttpError);
			expect((err as LocalServerHttpError).status).toBe(500);
		});

		test("listModels passes a refused connection through as the fetch error, not an HTTP error", async () => {
			const err = await adapter
				.create(refused)
				.listModels()
				.catch((e) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(LocalServerHttpError);
		});

		test("listModels honours the caller's signal, so a timeout stays distinguishable", async () => {
			fresh();
			const ctrl = new AbortController();
			ctrl.abort();
			const err = (await adapter
				.create(base)
				.listModels({ signal: ctrl.signal })
				.catch((e) => e)) as Error;
			expect(err.name).toBe("AbortError");
		});

		test("isHealthy is true when up, false on 500 and on refusal, and never throws", async () => {
			fresh();
			expect(await adapter.create(base).isHealthy()).toBe(true);
			expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${adapter.create(base).healthUrl}`]);
			fresh("500");
			expect(await adapter.create(base).isHealthy()).toBe(false);
			expect(await adapter.create(refused).isHealthy()).toBe(false);
		});

		test("calls fetch with one argument without a signal and with { signal } with one", async () => {
			const calls: unknown[][] = [];
			const spy: LocalFetch = (...args) => {
				calls.push(args);
				return Promise.resolve(adapter.answer(new URL(args[0]).pathname, MODELS) ?? new Response("", { status: 404 }));
			};
			const s = adapter.create(base, spy);
			await s.listModels();
			const signal = new AbortController().signal;
			await s.isHealthy({ signal });
			expect(calls[0]).toEqual([s.modelsUrl]);
			expect(calls[1]).toEqual([s.healthUrl, { signal }]);
		});
	});
}
