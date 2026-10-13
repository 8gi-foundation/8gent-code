import { describe, expect, test } from "bun:test";
import {
	LLAMA_SERVER_CAPABILITIES,
	capabilitiesFor,
	createLlamaRouter,
	isLoopbackUrl,
	isRouterMode,
	parsePrometheus,
	redactUrl,
	resolveLlamaServerUrl,
} from "./index";
import { cleanServerText, isSafeModelId } from "./llama-router";

type Call = { method: string; url: string; body?: unknown; hasSignal: boolean };

/** A stub llama-server keyed by "METHOD /path?query". Unknown routes answer 404. */
function stub(routes: Record<string, () => Response | Promise<Response>>, loadTimeoutMs = 1_000) {
	const calls: Call[] = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const u = new URL(input);
		const method = init?.method ?? "GET";
		calls.push({
			method,
			url: input,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			hasSignal: !!init?.signal,
		});
		const r = routes[`${method} ${u.pathname}${u.search}`];
		return r ? r() : new Response("not found", { status: 404 });
	};
	return {
		calls,
		router: createLlamaRouter({
			baseUrl: "http://127.0.0.1:8080/",
			fetch,
			pollMs: 0,
			loadTimeoutMs,
		}),
	};
}

// Shapes copied from the llama.cpp tools/server README, router section.
const ROUTER_MODELS = {
	data: [
		{ id: "qwen-27b", status: { value: "loaded", args: ["llama-server", "-ctx", "4096"] } },
		{ id: "gemma-4b", status: { value: "unloaded" } },
		{ id: "broken", status: { value: "unloaded", failed: true, exit_code: 1 } },
	],
};

describe("router endpoints", () => {
	test("health: 200 ok, 503 loading with the server's message, unreachable never throws", async () => {
		expect(
			await stub({ "GET /health": () => Response.json({ status: "ok" }) }).router.health(),
		).toEqual({ ok: true, httpStatus: 200, detail: "ok" });
		const loading = Response.json(
			{ error: { code: 503, message: "Loading model", type: "unavailable_error" } },
			{ status: 503 },
		);
		expect(await stub({ "GET /health": () => loading }).router.health()).toEqual({
			ok: false,
			httpStatus: 503,
			detail: "Loading model",
		});
		const dead = createLlamaRouter({
			baseUrl: "http://127.0.0.1:1",
			fetch: async () => {
				throw new TypeError("connection refused");
			},
		});
		const h = await dead.health();
		expect(h.ok).toBe(false);
		expect(h.httpStatus).toBe(0);
		expect(h.detail).toContain("connection refused");
	});

	test("every call carries a timeout signal; a timeout reads as 'timed out'", async () => {
		const s = stub({ "GET /health": () => Response.json({ status: "ok" }) });
		await s.router.health();
		expect(s.calls.every((c) => c.hasSignal)).toBe(true);
		const slow = createLlamaRouter({
			baseUrl: "http://127.0.0.1:8080",
			fetch: async () => {
				throw new DOMException("t", "TimeoutError");
			},
		});
		expect((await slow.health()).detail).toContain("timed out");
		expect(await slow.metrics()).toBe("timed out");
	});

	test("models: router GET /models with status; single server falls back to /v1/models", async () => {
		const r = stub({ "GET /models": () => Response.json(ROUTER_MODELS) });
		expect(await r.router.models()).toEqual([
			{ id: "qwen-27b", status: "loaded", failed: undefined, exitCode: undefined },
			{ id: "gemma-4b", status: "unloaded", failed: undefined, exitCode: undefined },
			{ id: "broken", status: "unloaded", failed: true, exitCode: 1 },
		]);
		const single = stub({
			"GET /v1/models": () => Response.json({ data: [{ id: "one" }, { object: "model" }] }),
		});
		expect(await single.router.models()).toEqual([
			{ id: "one", status: undefined, failed: undefined, exitCode: undefined },
		]);
		expect(single.calls.map((c) => c.url)).toEqual([
			"http://127.0.0.1:8080/models",
			"http://127.0.0.1:8080/v1/models",
		]);
		await expect(stub({}).router.models()).rejects.toThrow("HTTP 404");
	});

	test("load and unload POST {model} to the documented endpoints and surface the server's refusal", async () => {
		const s = stub({
			"POST /models/load": () => Response.json({ success: true }),
			"GET /models": () =>
				Response.json({ data: [{ id: "gemma-4b", status: { value: "loaded" } }] }),
			"POST /models/unload": () =>
				Response.json({ error: { message: "model is not loaded" } }, { status: 400 }),
		});
		expect(await s.router.load("gemma-4b")).toEqual({ ok: true, detail: "ok" });
		expect(await s.router.unload("gemma-4b")).toEqual({ ok: false, detail: "model is not loaded" });
		expect(s.calls.map((c) => [c.method, c.url, c.body])).toEqual([
			["POST", "http://127.0.0.1:8080/models/load", { model: "gemma-4b" }],
			["GET", "http://127.0.0.1:8080/models", undefined],
			["POST", "http://127.0.0.1:8080/models/unload", { model: "gemma-4b" }],
		]);
		expect(
			await stub({ "POST /models/load": () => Response.json({ success: false }) }).router.load("x"),
		).toEqual({
			ok: false,
			detail: "server said no",
		});
	});

	test("load waits through loading; a stale failure before progress is not trusted; a real failure is", async () => {
		// The router answers the POST at once, then reports: old failure, loading, loaded.
		const seq = [{ value: "unloaded", failed: true }, { value: "loading" }, { value: "loaded" }];
		let i = 0;
		const ok = stub({
			"POST /models/load": () => Response.json({ success: true }),
			"GET /models": () =>
				Response.json({ data: [{ id: "m", status: seq[Math.min(i++, seq.length - 1)] }] }),
		});
		expect(await ok.router.load("m")).toEqual({ ok: true, detail: "ok" });
		const fails = [{ value: "loading" }, { value: "unloaded", failed: true, exit_code: 1 }];
		let j = 0;
		const bad = stub({
			"POST /models/load": () => Response.json({ success: true }),
			"GET /models": () => Response.json({ data: [{ id: "m", status: fails[Math.min(j++, 1)] }] }),
		});
		expect((await bad.router.load("m")).detail).toBe(
			"the model process exited with code 1; the llama-server window has the reason",
		);
		const slow = stub(
			{
				"POST /models/load": () => Response.json({ success: true }),
				"GET /models": () => Response.json({ data: [{ id: "m", status: { value: "loading" } }] }),
			},
			20,
		);
		expect(await slow.router.load("m")).toEqual({ ok: false, detail: "still loading after 0 s" });
	});

	test("metrics and props take ?model= (URL-encoded) in router mode; metrics off is named", async () => {
		const s = stub({
			"GET /metrics?model=org%2Fm%3AQ4&autoload=false": () =>
				new Response(
					"# HELP x\nllamacpp:predicted_tokens_seconds 41.5\nllamacpp:requests_deferred 0\nother 1\n",
				),
			"GET /props?model=org%2Fm%3AQ4&autoload=false": () =>
				Response.json({ default_generation_settings: { n_ctx: 65536 }, is_sleeping: false }),
			"GET /metrics": () => new Response("", { status: 501 }),
		});
		expect(await s.router.metrics("org/m:Q4")).toEqual({
			"llamacpp:predicted_tokens_seconds": 41.5,
			"llamacpp:requests_deferred": 0,
		});
		expect(await s.router.props("org/m:Q4")).toEqual({ nCtx: 65536, sleeping: false });
		expect(await s.router.metrics()).toContain("--metrics");
	});
});

describe("router mode detection", () => {
	test("more than one model, or any router status, is router mode; adapter then reports multiModel", () => {
		expect(isRouterMode([])).toBe(false);
		expect(isRouterMode([{}])).toBe(false);
		expect(isRouterMode([{ status: { value: "loaded" } }])).toBe(true);
		expect(isRouterMode([{}, {}])).toBe(true);
		expect(capabilitiesFor([{ name: "a" }])).toBe(LLAMA_SERVER_CAPABILITIES);
		expect(capabilitiesFor([{ name: "a" }, { name: "b" }]).multiModel).toBe(true);
		expect(LLAMA_SERVER_CAPABILITIES.multiModel).toBe(false);
	});

	test("parsePrometheus keeps only the known gauges and skips labelled series", () => {
		expect(
			parsePrometheus(
				'llamacpp:n_tokens_max 9000\r\nllamacpp:prompt_tokens_seconds{a="b"} 3\nllamacpp:requests_processing NaN',
			),
		).toEqual({
			"llamacpp:n_tokens_max": 9000,
		});
	});
});

describe("loopback guard", () => {
	test("loopback hosts pass", () => {
		for (const u of [
			"http://127.0.0.1:8080",
			"http://localhost:8080",
			"http://[::1]:8080",
			"http://127.1.2.3",
		])
			expect(isLoopbackUrl(u)).toBe(true);
		for (const u of [
			"http://192.168.77.5:8080",
			"http://gpu:8080",
			"http://0.0.0.0:8080",
			"http://127.0.0.1.evil.com",
			"nope",
		])
			expect(isLoopbackUrl(u)).toBe(false);
	});

	test("a non-loopback LLAMA_SERVER_URL is refused with one warning unless EIGHT_ALLOW_REMOTE_LLAMA=1", () => {
		const warnings: string[] = [];
		const warn = (l: string) => warnings.push(l);
		expect(resolveLlamaServerUrl({ LLAMA_SERVER_URL: "http://192.168.77.5:8080/v1" }, warn)).toBe(
			"http://127.0.0.1:8080",
		);
		expect(resolveLlamaServerUrl({ LLAMA_SERVER_URL: "http://192.168.77.5:8080" }, warn)).toBe(
			"http://127.0.0.1:8080",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("EIGHT_ALLOW_REMOTE_LLAMA=1");
		expect(
			resolveLlamaServerUrl(
				{ LLAMA_SERVER_URL: "http://192.168.77.5:8080", EIGHT_ALLOW_REMOTE_LLAMA: "1" },
				warn,
			),
		).toBe("http://192.168.77.5:8080");
		expect(resolveLlamaServerUrl({ LLAMA_SERVER_URL: "localhost:9090" }, warn)).toBe(
			"http://localhost:9090",
		);
	});
});

describe("loopback guard against look-alike hosts (8SO)", () => {
	test("names, userinfo, fragments, backslashes and non-http schemes are refused", () => {
		for (const u of [
			"http://localhost.evil.com",
			"http://127.0.0.1.nip.io",
			"http://127.0.0.1@evil.com",
			"http://127.0.0.1:80@evil.com:8080",
			"http://evil.com#@127.0.0.1",
			"http://evil.com\\@127.0.0.1",
			"http://localhost.",
			"http://[::ffff:127.0.0.1]:8080",
			"file://localhost/etc/passwd",
			"ftp://127.0.0.1/",
		])
			expect(isLoopbackUrl(u)).toBe(false);
	});

	test("numeric IPv4 forms are judged after URL normalisation, so only real loopback passes", () => {
		for (const u of [
			"http://2130706433",
			"http://0177.0.0.1",
			"http://0x7f.1",
			"http://127.0.0.1.",
		])
			expect(isLoopbackUrl(u)).toBe(true);
		expect(isLoopbackUrl("http://3232235777")).toBe(false); // 192.168.1.1
	});

	test("a file: URL is refused even with EIGHT_ALLOW_REMOTE_LLAMA=1, and warnings never print a password", () => {
		const warnings: string[] = [];
		const warn = (l: string) => warnings.push(l);
		expect(
			resolveLlamaServerUrl(
				{ LLAMA_SERVER_URL: "file:///etc/hosts", EIGHT_ALLOW_REMOTE_LLAMA: "1" },
				warn,
			),
		).toBe("http://127.0.0.1:8080");
		resolveLlamaServerUrl({ LLAMA_SERVER_URL: "http://me:hunter2@203.0.113.9:8080" }, warn);
		expect(warnings.join("\n")).not.toContain("hunter2");
		expect(redactUrl("http://me:hunter2@203.0.113.9:8080")).toBe("http://203.0.113.9:8080");
	});
});

describe("server strings are untrusted (8SO)", () => {
	test("ids with escapes, invisibles, spaces or over 256 chars are dropped; the list is capped", async () => {
		const bad = [
			"a\u001b[2Jb",
			"x\u200by",
			"rtl\u202egnp",
			"two words",
			"n\nl",
			"z".repeat(257),
			"",
		];
		const many = Array.from({ length: 1_500 }, (_, i) => ({ id: `m${i}` }));
		const { router } = stub({
			"GET /models": () =>
				Response.json({
					data: [...bad.map((id) => ({ id })), { id: "org/model:Q4_K_M" }, ...many],
				}),
		});
		const ids = (await router.models()).map((m) => m.id);
		for (const b of bad) expect(ids).not.toContain(b);
		expect(ids[0]).toBe("org/model:Q4_K_M");
		expect(ids.length).toBeLessThanOrEqual(1_000);
		expect(isSafeModelId("qwen3.6-27b")).toBe(true);
	});

	test("an unknown status is kept, cleaned, so a load keeps waiting instead of calling it loaded", async () => {
		const { router } = stub({
			"GET /models": () =>
				Response.json({ data: [{ id: "a", status: { value: "\u001b[31mweird" } }] }),
		});
		expect((await router.models())[0].status).toBe("[31mweird");
	});

	test("server error text loses escapes and newlines and is cut", async () => {
		const { router } = stub({
			"POST /models/unload": () =>
				Response.json(
					{ error: `\u001b]0;pwned\u0007line1\nline2${"x".repeat(1_000)}` },
					{ status: 400 },
				),
		});
		const r = await router.unload("a");
		expect(r.ok).toBe(false);
		expect(r.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(r.detail.length).toBeLessThanOrEqual(303);
		expect(cleanServerText("a\u202eb\u200bc")).toBe("a b c");
	});
});
