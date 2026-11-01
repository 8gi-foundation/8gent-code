/**
 * #5035: per-tab context window. Resolution from each provider's own models
 * list (stubbed), the session cache, the per-tab override on disk, and two tabs
 * on different models.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/temp-dirs";
import {
	WINDOW_FIELDS,
	clearWindowCache,
	resolveContextWindow,
	resolveContextWindowCached,
} from "./context-window.js";
import {
	effectiveWindow,
	loadOverrides,
	parseWindowInput,
	saveOverride,
} from "./tab-context-window.js";

type Call = { url: string; auth: string | null };
function stub(body: unknown, calls: Call[] = []): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url: String(url), auth: headers.Authorization ?? null });
		return { ok: true, headers: new Headers(), json: async () => body };
	}) as unknown as typeof fetch;
}

beforeEach(() => clearWindowCache());

describe("window resolution per provider", () => {
	test("openrouter: the catalogue's context_length, no key sent", async () => {
		const calls: Call[] = [];
		const w = await resolveContextWindow({
			provider: "openrouter",
			model: "a/b",
			apiKey: "secret",
			baseUrl: "https://openrouter.ai/api/v1",
			fetchImpl: stub({ data: [{ id: "a/b", context_length: 262144 }] }, calls),
		});
		expect(w).toEqual({ window: 262144, source: "provider" });
		expect(calls[0]?.auth).toBeNull();
	});

	test("a hosted OpenAI-compatible provider (MiniMax baseUrl): its own models list, with the owner's key", async () => {
		const calls: Call[] = [];
		const w = await resolveContextWindow({
			provider: "minimax",
			model: "m-flash",
			baseUrl: "https://api.minimax.io/v1/",
			apiKey: "k-1",
			fetchImpl: stub(
				{
					object: "list",
					data: [
						{ id: "other", object: "model", context_length: 1000 },
						{ id: "m-flash", object: "model", owned_by: "x", context_length: 204800 },
					],
				},
				calls,
			),
		});
		expect(w).toEqual({ window: 204800, source: "provider" });
		expect(calls[0]).toEqual({ url: "https://api.minimax.io/v1/models", auth: "Bearer k-1" });
	});

	test.each([...WINDOW_FIELDS])(
		"a list that names the window `%s` is read",
		async (field: string) => {
			const w = await resolveContextWindow({
				provider: "groq",
				model: "g",
				baseUrl: "https://example.test/v1",
				fetchImpl: stub({ data: [{ id: "g", [field]: 131072 }] }),
			});
			expect(w.window).toBe(131072);
		},
	);

	test("a list with no window field is unknown, never a guess or the first entry", async () => {
		const w = await resolveContextWindow({
			provider: "minimax",
			model: "m-flash",
			baseUrl: "https://api.minimax.io/v1",
			apiKey: "k",
			fetchImpl: stub({
				data: [
					{ id: "m-flash", object: "model" },
					{ id: "x", context_length: 5 },
				],
			}),
		});
		expect(w).toEqual({ window: null, source: "unknown" });
	});

	test("a model not in the list is unknown", async () => {
		const w = await resolveContextWindow({
			provider: "minimax",
			model: "missing",
			baseUrl: "https://api.minimax.io/v1",
			fetchImpl: stub({ data: [{ id: "x", context_length: 5 }] }),
		});
		expect(w.window).toBeNull();
	});

	test("a local provider is never sent to a models list", async () => {
		const calls: Call[] = [];
		await resolveContextWindow({
			provider: "ollama",
			model: "q",
			baseUrl: "http://127.0.0.1:11434/v1",
			fetchImpl: stub({ data: [{ id: "q", context_length: 9 }] }, calls),
		});
		expect(calls.every((c) => !c.url.endsWith("/v1/models"))).toBe(true);
	});

	test("the answer is cached per provider and model for the session", async () => {
		const calls: Call[] = [];
		const o = {
			provider: "minimax",
			model: "m",
			baseUrl: "https://api.minimax.io/v1",
			fetchImpl: stub({ data: [{ id: "m", context_length: 100000 }] }, calls),
		};
		await resolveContextWindowCached(o);
		await resolveContextWindowCached(o);
		expect(calls.length).toBe(1);
		await resolveContextWindowCached({ ...o, model: "m2" });
		expect(calls.length).toBe(2);
	});

	test("an unknown answer is not cached: a key added later is picked up", async () => {
		const calls: Call[] = [];
		const base = {
			provider: "minimax",
			model: "m",
			baseUrl: "https://api.minimax.io/v1",
		};
		const first = await resolveContextWindowCached({
			...base,
			fetchImpl: stub({ data: [] }, calls),
		});
		expect(first.window).toBeNull();
		const second = await resolveContextWindowCached({
			...base,
			fetchImpl: stub({ data: [{ id: "m", context_length: 64000 }] }, calls),
		});
		expect(second.window).toBe(64000);
	});
});

describe("per-tab override", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tabwin5035-"));
		file = join(dir, "tab-context-windows.json");
	});
	afterEach(() => removeDir(dir));

	test("an override beats the detected value; clearing returns to detected", () => {
		const detected = { window: 204800, source: "provider" as const };
		expect(effectiveWindow(detected, 64000)).toEqual({ window: 64000, source: "override" });
		expect(effectiveWindow(detected, null)).toEqual(detected);
		expect(effectiveWindow(null, null)).toBeNull();
		expect(effectiveWindow(null, 32000)).toEqual({ window: 32000, source: "override" });
	});

	test("it is stored per tab and survives a restart (a fresh read of the file)", () => {
		saveOverride("tab-a", 64000, file);
		saveOverride("tab-b", 1_000_000, file);
		expect(loadOverrides(file)).toEqual({ "tab-a": 64000, "tab-b": 1_000_000 });
		saveOverride("tab-a", null, file);
		expect(loadOverrides(file)).toEqual({ "tab-b": 1_000_000 });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "tab-b": 1_000_000 });
	});

	test("a missing, corrupt or hostile file reads as no overrides", () => {
		expect(loadOverrides(join(dir, "nope.json"))).toEqual({});
		saveOverride("x", 5, file);
		Bun.write(file, "{not json");
		expect(loadOverrides(file)).toEqual({});
		Bun.write(file, JSON.stringify({ a: -1, b: "9", c: 1e12, d: 4096 }));
		expect(loadOverrides(file)).toEqual({ d: 4096 });
	});

	test("typed sizes: 128k, 1.5m, 200000; anything else is refused", () => {
		expect(parseWindowInput("128k")).toBe(128000);
		expect(parseWindowInput(" 1.5M ")).toBe(1_500_000);
		expect(parseWindowInput("200000")).toBe(200000);
		for (const bad of ["", "abc", "-5", "0", "12k4", "1e9"])
			expect(parseWindowInput(bad)).toBeNull();
	});

	test("two tabs on different models keep different windows", async () => {
		const fetchImpl = stub({
			data: [
				{ id: "small", context_length: 32768 },
				{ id: "big", context_length: 1_000_000 },
			],
		});
		const base = { provider: "minimax", baseUrl: "https://api.minimax.io/v1", fetchImpl };
		const a = await resolveContextWindowCached({ ...base, model: "small" });
		const b = await resolveContextWindowCached({ ...base, model: "big" });
		saveOverride("tab-b", 500_000, file);
		const overrides = loadOverrides(file);
		expect(effectiveWindow(a, overrides["tab-a"])?.window).toBe(32768);
		expect(effectiveWindow(b, overrides["tab-b"])?.window).toBe(500_000);
		// Changing tab-a's model re-resolves tab-a only.
		const a2 = await resolveContextWindowCached({ ...base, model: "big" });
		expect(effectiveWindow(a2, overrides["tab-a"])?.window).toBe(1_000_000);
		expect(effectiveWindow(b, overrides["tab-b"])?.window).toBe(500_000);
	});
});
