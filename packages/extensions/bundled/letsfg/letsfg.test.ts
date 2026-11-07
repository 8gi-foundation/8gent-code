/**
 * LetsFG extension (search only). The service is a mocked fetch: nothing here reaches
 * the network. The last block runs the real child through the host, using only calls
 * that fail validation before any request is built, so a token on the machine is never used.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { enableExtension, startProcessExtension } from "../../process";
import { type Deps, baseFromEnv, handle, serve } from "./letsfg";

const OFFER = {
	id: "off_1",
	price: 120.5,
	currency: "EUR",
	airline: "Aer Lingus",
	route: "DUB-JFK",
	departure_time: "2026-12-01T09:00",
	duration_minutes: 480,
	stops: 0,
};

interface Seen {
	method: string;
	path: string;
	auth: string | null;
	body: unknown;
}

function setup(over: Partial<Deps> & { offers?: unknown[]; status?: string[] } = {}) {
	const seen: Seen[] = [];
	const statuses = [...(over.status ?? ["completed"])];
	const fetcher = (async (url: string, init: RequestInit = {}) => {
		const u = new URL(url);
		const headers = new Headers(init.headers);
		seen.push({
			method: init.method ?? "GET",
			path: u.pathname,
			auth: headers.get("authorization"),
			body: init.body ? JSON.parse(String(init.body)) : undefined,
		});
		const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
		if (u.pathname.endsWith("/search")) return j({ search_id: "s1", status: "searching" });
		if (u.pathname.includes("/results/"))
			return j({
				status: statuses.length > 1 ? statuses.shift() : statuses[0],
				total_results: 1,
				offers: over.offers ?? [OFFER],
			});
		if (u.pathname.endsWith("/agent-book/status"))
			return j({ state: "completed", pnr: "ABC123", charged_amount: 120.5, secret: "leak" });
		return new Response("nope", { status: 404 });
	}) as unknown as typeof fetch;
	const d: Deps = {
		fetch: fetcher,
		baseUrl: "https://mock.invalid/api",
		token: () => "tok_test",
		sleep: async () => {},
		pollMs: 1000,
		pollEveryMs: 0,
		...over,
	};
	return { d, seen };
}

const rpc = (id: number, method: string, params?: unknown) => ({
	jsonrpc: "2.0",
	id,
	method,
	params,
});
const call = async (d: Deps, name: string, args: Record<string, unknown>) => {
	const r = (await handle(d, rpc(1, "tools/call", { name, arguments: args }))) as {
		result: { isError?: boolean; content: { text: string }[] };
	};
	return { error: !!r.result.isError, text: r.result.content[0].text };
};

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

const SEARCH = { origin: "DUB", destination: "JFK", date_from: "2026-12-01" };

describe("search", () => {
	test("posts the search, polls until done, sends the bearer token, says nothing is held", async () => {
		const { d, seen } = setup({ status: ["searching", "searching", "completed"] });
		const r = await call(d, "search_flights", { ...SEARCH, origin: "dub", destination: "jfk" });
		expect(r.error).toBe(false);
		const out = JSON.parse(r.text);
		expect(out.search_id).toBe("s1");
		expect(out.offers[0]).toMatchObject({ offer_id: "off_1", price: 120.5, currency: "EUR" });
		expect(out.note).toContain("Nothing is held or bought");
		expect(seen[0]).toMatchObject({ method: "POST", path: "/api/search", auth: "Bearer tok_test" });
		expect(seen[0].body).toEqual(SEARCH);
		expect(seen.filter((s) => s.path.includes("/results/")).length).toBe(3);
		expect(seen.some((s) => s.path.endsWith("/agent-book"))).toBe(false);
	});

	test("bad input fails before any request", async () => {
		const { d, seen } = setup();
		for (const args of [
			{ origin: "DUBLIN", destination: "JFK", date_from: "2026-12-01" },
			{ origin: "DUB", destination: "JFK", date_from: "tomorrow" },
			{ origin: "DUB", destination: "JFK" },
		])
			expect((await call(d, "search_flights", args)).error).toBe(true);
		expect(seen).toEqual([]);
	});

	test("no token: a clear message, no request", async () => {
		const { d, seen } = setup({ token: () => null });
		const r = await call(d, "search_flights", SEARCH);
		expect(r.error).toBe(true);
		expect(r.text).toContain("No LetsFG token");
		expect(seen).toEqual([]);
	});

	test("the token never appears in any reply", async () => {
		const { d } = setup({ status: ["searching"], pollMs: 0 });
		expect((await call(d, "search_flights", SEARCH)).text).not.toContain("tok_test");
	});

	test("status lookup returns only state, record locator and charge", async () => {
		const { d, seen } = setup();
		const r = await call(d, "get_flight_booking", { booking_ref: "ref_1" });
		expect(JSON.parse(r.text)).toEqual({
			state: "completed",
			pnr: "ABC123",
			charged_amount: 120.5,
		});
		expect(seen[0].path).toBe("/api/agent-book/status");
	});
});

describe("read-only: there is no way to book", () => {
	test("the tool list holds no booking call, and the manifest declares none", async () => {
		const r = (await handle(setup().d, rpc(1, "tools/list"))) as {
			result: { tools: { name: string }[] };
		};
		expect(r.result.tools.map((t) => t.name).sort()).toEqual([
			"get_flight_booking",
			"get_flight_results",
			"search_flights",
		]);
		const m = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "manifest.json"), "utf-8"));
		expect(m.permissions.join()).not.toContain("book_flight");
	});

	test("calling book_flight sends nothing", async () => {
		const { d, seen } = setup();
		const r = await call(d, "book_flight", {
			search_id: "s1",
			offer_id: "off_1",
			contact_email: "a@example.com",
			passenger: { given_name: "Ada" },
		});
		expect(r.error).toBe(true);
		expect(seen).toEqual([]);
	});

	test("the source holds no booking request", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "letsfg.ts"), "utf-8");
		expect(src).not.toMatch(/"POST", "\/agent-book"/);
		expect(src).not.toContain("/dev/tty");
	});
});

describe("text from the service", () => {
	test("bidi marks, separators and zero-width characters are replaced in every field", async () => {
		const bad =
			"A\u200eB\u200fC\u061cD\u2028E\u2029F\u200bG\u200cH\u200dI\u2060J\ufeffK\u202eL\u2066M\u001bN";
		const { d } = setup({
			offers: [{ ...OFFER, id: bad, airline: bad, route: bad, currency: bad }],
		});
		const r = await call(d, "get_flight_results", { search_id: "s1" });
		expect(UNSAFE.test(JSON.parse(r.text).offers[0].summary)).toBe(false);
		const o = JSON.parse(r.text).offers[0];
		for (const v of [o.offer_id, o.currency, o.summary]) expect(UNSAFE.test(v)).toBe(false);
	});
});

describe("service address", () => {
	test("https only", () => {
		expect(baseFromEnv({})).toBe("https://letsfg.co/api");
		expect(baseFromEnv({ LETSFG_BASE_URL: "https://x.example/api/" })).toBe(
			"https://x.example/api",
		);
		for (const bad of [
			"http://x.example/api",
			"ftp://x",
			"file:///etc/passwd",
			"letsfg.co/api",
			"javascript:1",
		])
			expect(() => baseFromEnv({ LETSFG_BASE_URL: bad })).toThrow();
	});
});

describe("messages are handled strictly in order", () => {
	test("a slow first call finishes before the second starts, and a split line is one message", async () => {
		const events: string[] = [];
		const { d } = setup({
			fetch: (async (url: string) => {
				const u = new URL(url);
				const first = u.pathname.includes("/results/slow");
				events.push(`start ${first ? "slow" : "fast"}`);
				if (first) await new Promise((r) => setTimeout(r, 40));
				events.push(`end ${first ? "slow" : "fast"}`);
				return new Response(JSON.stringify({ status: "completed", offers: [] }), { status: 200 });
			}) as unknown as typeof fetch,
		});
		const input = new PassThrough();
		const out: string[] = [];
		const done = serve(d, input, (l) => out.push(l));
		const a = JSON.stringify(
			rpc(1, "tools/call", { name: "get_flight_results", arguments: { search_id: "slow" } }),
		);
		const b = JSON.stringify(
			rpc(2, "tools/call", { name: "get_flight_results", arguments: { search_id: "fast" } }),
		);
		input.write(`${a}\n${b.slice(0, 20)}`);
		await new Promise((r) => setTimeout(r, 10));
		input.write(`${b.slice(20)}\n`);
		input.end();
		await done;
		expect(events).toEqual(["start slow", "end slow", "start fast", "end fast"]);
		expect(out.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
	});

	test("a malformed line is skipped and later messages still answer", async () => {
		const { d } = setup();
		const input = new PassThrough();
		const out: string[] = [];
		const done = serve(d, input, (l) => out.push(l));
		input.write(`not json\n${JSON.stringify(rpc(7, "tools/list"))}\n`);
		input.end();
		await done;
		expect(out.length).toBe(1);
		expect(JSON.parse(out[0]).id).toBe(7);
	});
});

describe("through the host, as shipped", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-letsfg-"));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const dir = () => {
		const d = path.join(root, "letsfg");
		fs.cpSync(import.meta.dir, d, { recursive: true, filter: (s) => !s.endsWith(".test.ts") });
		return d;
	};

	test("ships disabled: the prompt says No, nothing starts", async () => {
		const d = dir();
		await expect(startProcessExtension(d, { attended: true })).rejects.toThrow("disabled");
		expect(await enableExtension(d, "manifest.json", async () => false)).toBe(false);
		expect(await enableExtension(d)).toBe(false);
		expect(fs.existsSync(path.join(d, ".enabled"))).toBe(false);
	});

	test("enabled: three read-only tools, a bad call fails before any request", async () => {
		const d = dir();
		expect(await enableExtension(d, "manifest.json", async () => true)).toBe(true);
		const ext = await startProcessExtension(d, { attended: true });
		try {
			expect(Object.keys(ext.tools).sort()).toEqual([
				"get_flight_booking",
				"get_flight_results",
				"search_flights",
			]);
			expect(await ext.tools.search_flights({ origin: "nope" })).toContain("origin");
		} finally {
			ext.close();
		}
	});
});
