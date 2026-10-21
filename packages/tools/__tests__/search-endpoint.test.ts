/**
 * #4613: EIGHT_SEARCH_URL lets web_search use a self-hosted SearXNG-style
 * endpoint. The configured origin, and only it, may be private, and only for
 * the search call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dotenvDeclaredKeys } from "../../permissions/run-command-sandbox";
import { BlockedDestinationError, normalizeOrigin, searchEndpointFetch } from "../net-guard";
import { mapSearchJson, probeSearchEndpoint, resolveSearchUrl, webFetch, webSearch } from "../web";

const ENDPOINT = "http://127.0.0.1:8888/search";

const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});

function recorder(respond: (url: string) => Response | Promise<Response>) {
	const urls: string[] = [];
	const fetchImpl = async (url: string, _init: RequestInit) => {
		urls.push(url);
		return respond(url);
	};
	return { urls, fetchImpl };
}

describe("JSON mapping", () => {
	test("SearXNG results map to SearchResult", async () => {
		const { urls, fetchImpl } = recorder(() =>
			json({
				results: [
					{ title: "Bun", url: "https://bun.sh/", content: "A fast runtime" },
					{ title: "No url", content: "x" },
					{ title: "Bad scheme", url: "javascript:alert(1)", content: "x" },
					{ title: "Node", url: "https://nodejs.org/", content: "Another" },
				],
			}),
		);
		const r = await webSearch("bun runtime", { searchUrl: ENDPOINT, fetchImpl });
		expect(r).toEqual([
			{ title: "Bun", url: "https://bun.sh/", snippet: "A fast runtime" },
			{ title: "Node", url: "https://nodejs.org/", snippet: "Another" },
		]);
		const u = new URL(urls[0]);
		expect(u.origin).toBe("http://127.0.0.1:8888");
		expect(u.pathname).toBe("/search");
		expect(u.searchParams.get("q")).toBe("bun runtime");
		expect(u.searchParams.get("format")).toBe("json");
	});

	test("maxResults caps the list", () => {
		const body = JSON.stringify({
			results: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}` })),
		});
		expect(mapSearchJson(body, 2)).toHaveLength(2);
	});

	test("control characters are stripped from title and snippet", () => {
		const body = JSON.stringify({
			results: [
				{
					title: "Hi\u001b[31m red\u0007\nline",
					url: "https://e.com/",
					content: "a\u0000b\r\nc\u009d",
				},
			],
		});
		const [r] = mapSearchJson(body, 5);
		expect(r.title).toBe("Hi [31m red line");
		expect(r.snippet).toBe("a b c");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
		expect(/[\u0000-\u001f\u007f-\u009f]/.test(r.title + r.snippet)).toBe(false);
	});

	test("non-JSON and shapeless bodies give plain errors", () => {
		expect(() => mapSearchJson("<html>", 5)).toThrow(/did not return JSON/);
		expect(() => mapSearchJson("{}", 5)).toThrow(/no results array/);
	});
});

describe("unset keeps the DuckDuckGo path", () => {
	test("no configured URL means the request goes to html.duckduckgo.com", async () => {
		const real = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (u: string) => {
			seen.push(String(u));
			return new Response(
				'<div class="result"><h2 class="result__title"><a href="https://a.com/">A</a></h2><a class="result__snippet">s</a></div>',
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		try {
			const r = await webSearch("q", {});
			expect(new URL(seen[0]).host).toBe("html.duckduckgo.com");
			expect(r[0].url).toBe("https://a.com/");
		} finally {
			globalThis.fetch = real;
		}
	});

	test("probe is null when unconfigured", async () => {
		expect(await probeSearchEndpoint({})).toBeNull();
	});
});

describe("guard exemption is scoped to the configured origin", () => {
	test("the configured private host is allowed for search", async () => {
		const { fetchImpl } = recorder(() => json({ results: [] }));
		await expect(searchEndpointFetch(`${ENDPOINT}?q=x`, ENDPOINT, { fetchImpl })).resolves.toBe(
			'{"results":[]}',
		);
	});

	test("the same host is still refused for web_fetch", async () => {
		const { urls, fetchImpl } = recorder(() => json({}));
		await expect(
			webFetch(ENDPOINT, {
				net: { fetchImpl, resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
			}),
		).rejects.toBeInstanceOf(BlockedDestinationError);
		expect(urls).toHaveLength(0);
	});

	test("a different host or port or scheme is refused", async () => {
		const { urls, fetchImpl } = recorder(() => json({ results: [] }));
		for (const bad of [
			"http://127.0.0.1:8889/search?q=x",
			"http://127.0.0.2:8888/search?q=x",
			"http://localhost:8888/search?q=x",
			"https://127.0.0.1:8888/search?q=x",
			"http://169.254.169.254/latest/meta-data",
			"http://127.0.0.1:8888@evil.example/",
		]) {
			await expect(searchEndpointFetch(bad, ENDPOINT, { fetchImpl })).rejects.toBeInstanceOf(
				BlockedDestinationError,
			);
		}
		expect(urls).toHaveLength(0);
	});

	test("origins compare after normalisation", () => {
		expect(normalizeOrigin("HTTP://Example.COM:80/x")).toBe(normalizeOrigin("http://example.com"));
		expect(normalizeOrigin("http://u:p@example.com")).toBeNull();
		expect(normalizeOrigin("ftp://example.com")).toBeNull();
	});

	test("redirects are not followed", async () => {
		const { urls, fetchImpl } = recorder(
			() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
		);
		await expect(searchEndpointFetch(`${ENDPOINT}?q=x`, ENDPOINT, { fetchImpl })).rejects.toThrow(
			/redirect/,
		);
		expect(urls).toHaveLength(1);
	});

	test("response size is capped, declared or streamed", async () => {
		const big = "x".repeat(1024 * 1024 + 10);
		const streamed = recorder(() => new Response(big, { status: 200 }));
		await expect(
			searchEndpointFetch(ENDPOINT, ENDPOINT, { fetchImpl: streamed.fetchImpl }),
		).rejects.toThrow(/too large/);
		const declared = recorder(
			() => new Response("{}", { status: 200, headers: { "content-length": String(big.length) } }),
		);
		await expect(
			searchEndpointFetch(ENDPOINT, ENDPOINT, { fetchImpl: declared.fetchImpl }),
		).rejects.toThrow(/too large/);
	});
});

describe("dead endpoint", () => {
	test("a refused connection gives a plain error and never falls back to the public site", async () => {
		const real = globalThis.fetch;
		const publicCalls: string[] = [];
		globalThis.fetch = (async (u: string) => {
			publicCalls.push(String(u));
			throw new Error("should not be called");
		}) as unknown as typeof fetch;
		try {
			const fetchImpl = async () => {
				throw new Error("ECONNREFUSED");
			};
			await expect(webSearch("q", { searchUrl: ENDPOINT, fetchImpl })).rejects.toThrow(
				/Search endpoint http:\/\/127\.0\.0\.1:8888 failed: ECONNREFUSED/,
			);
			expect(publicCalls).toHaveLength(0);
		} finally {
			globalThis.fetch = real;
		}
	});

	test("HTTP errors and probe results", async () => {
		const down = recorder(() => new Response("no", { status: 503, statusText: "Unavailable" }));
		await expect(
			webSearch("q", { searchUrl: ENDPOINT, fetchImpl: down.fetchImpl }),
		).rejects.toThrow(/503/);
		const probeDown = await probeSearchEndpoint({ searchUrl: ENDPOINT, fetchImpl: down.fetchImpl });
		expect(probeDown?.ok).toBe(false);
		const up = recorder(() => json({ results: [] }));
		expect(await probeSearchEndpoint({ searchUrl: ENDPOINT, fetchImpl: up.fetchImpl })).toEqual({
			origin: "http://127.0.0.1:8888",
			ok: true,
		});
	});
});

describe(".env-declared value is ignored", () => {
	test("resolveSearchUrl drops a declared key and invalid values", () => {
		expect(resolveSearchUrl(ENDPOINT, new Set())).toBe(ENDPOINT);
		expect(resolveSearchUrl(ENDPOINT, new Set(["EIGHT_SEARCH_URL"]))).toBeUndefined();
		expect(resolveSearchUrl("not a url", new Set())).toBeUndefined();
		expect(resolveSearchUrl("file:///etc/passwd", new Set())).toBeUndefined();
		expect(resolveSearchUrl(undefined, new Set())).toBeUndefined();
	});

	let dir: string;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-4613-"));
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("a cloned project's .env cannot set it (real process, real .env in cwd)", () => {
		fs.writeFileSync(path.join(dir, ".env"), "EIGHT_SEARCH_URL=http://127.0.0.1:9999/search\n");
		const probe = `import { configuredSearchUrl } from ${JSON.stringify(path.resolve(import.meta.dir, "../web.ts"))}; console.log(JSON.stringify(configuredSearchUrl() ?? null));`;
		const run = (env: Record<string, string>) =>
			Bun.spawnSync(["bun", "-e", probe], {
				cwd: dir,
				env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
			});
		// .env only: Bun loads it into process.env, the snapshot drops it.
		expect(run({}).stdout.toString().trim()).toBe("null");
		// Same key in the real environment AND in .env: still dropped (declared wins).
		expect(run({ EIGHT_SEARCH_URL: ENDPOINT }).stdout.toString().trim()).toBe("null");
		// Real environment, no .env: honoured.
		fs.rmSync(path.join(dir, ".env"));
		expect(run({ EIGHT_SEARCH_URL: ENDPOINT }).stdout.toString().trim()).toBe(
			JSON.stringify(ENDPOINT),
		);
		expect(dotenvDeclaredKeys([path.join(dir, ".env")]).size).toBe(0);
	});
});
