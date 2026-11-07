/**
 * LetsFG extension. The service is a mocked fetch: nothing here reaches the network.
 * The last block runs the real child through the host, using only calls that fail
 * validation before any request is built, so a token on the machine is never used.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enableExtension, startProcessExtension } from "../../process";
import { type Deps, handle } from "./letsfg";

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
	body: any;
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
		if (u.pathname.endsWith("/agent-book"))
			return j({ ok: true, booking_ref: "ref_1", state: "authorised", held: { amount: 120.5 } });
		if (u.pathname.endsWith("/agent-book/status")) return j({ state: "completed", pnr: "ABC123" });
		return new Response("nope", { status: 404 });
	}) as unknown as typeof fetch;
	const asked: string[] = [];
	const d: Deps = {
		fetch: fetcher,
		baseUrl: "http://mock.invalid/api",
		token: () => "tok_test",
		ask: async (s) => {
			asked.push(s);
			return false;
		},
		sleep: async () => {},
		pollMs: 1000,
		pollEveryMs: 0,
		...over,
	};
	return { d, seen, asked };
}

const call = async (d: Deps, name: string, args: Record<string, unknown>) => {
	const r: any = await handle(d, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	return { error: !!r.result.isError, text: r.result.content[0].text as string };
};

const BOOK = {
	search_id: "s1",
	offer_id: "off_1",
	contact_email: "a@example.com",
	passenger: { given_name: "Ada", family_name: "Lovelace" },
};

describe("search", () => {
	test("posts the search, polls until done, sends the bearer token, says nothing is held", async () => {
		const { d, seen } = setup({ status: ["searching", "searching", "completed"] });
		const r = await call(d, "search_flights", {
			origin: "dub",
			destination: "jfk",
			date_from: "2026-12-01",
		});
		expect(r.error).toBe(false);
		const out = JSON.parse(r.text);
		expect(out.search_id).toBe("s1");
		expect(out.offers[0]).toMatchObject({ offer_id: "off_1", price: 120.5, currency: "EUR" });
		expect(out.note).toContain("Nothing is held or bought");
		expect(seen[0]).toMatchObject({ method: "POST", path: "/api/search", auth: "Bearer tok_test" });
		expect(seen[0].body).toEqual({ origin: "DUB", destination: "JFK", date_from: "2026-12-01" });
		expect(seen.filter((s) => s.path.includes("/results/")).length).toBe(3);
		expect(seen.some((s) => s.path.includes("agent-book"))).toBe(false);
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
		const r = await call(d, "search_flights", {
			origin: "DUB",
			destination: "JFK",
			date_from: "2026-12-01",
		});
		expect(r.error).toBe(true);
		expect(r.text).toContain("No LetsFG token");
		expect(seen).toEqual([]);
	});

	test("the token never appears in any reply", async () => {
		const { d } = setup({ status: ["searching"], pollMs: 0 });
		const r = await call(d, "search_flights", {
			origin: "DUB",
			destination: "JFK",
			date_from: "2026-12-01",
		});
		expect(r.text).not.toContain("tok_test");
	});
});

describe("booking needs a yes, every time", () => {
	test("No (or no terminal) sends nothing to the booking endpoint", async () => {
		const { d, seen, asked } = setup();
		const r = await call(d, "book_flight", BOOK);
		expect(r.text).toContain("Not booked");
		expect(asked.length).toBe(1);
		expect(seen.some((s) => s.path.includes("agent-book"))).toBe(false);
	});

	test("the person sees the item and the price, taken from the service not the caller", async () => {
		const { d, asked } = setup();
		await call(d, "book_flight", { ...BOOK, price: 1, currency: "USD" });
		expect(asked[0]).toContain("Aer Lingus");
		expect(asked[0]).toContain("DUB-JFK");
		expect(asked[0]).toContain("120.5 EUR each, 120.50 EUR in total");
		expect(asked[0]).toContain("held");
	});

	test("the total counts every traveller", async () => {
		const { d, asked } = setup();
		await call(d, "book_flight", { ...BOOK, additional_passengers: [{ given_name: "B" }] });
		expect(asked[0]).toContain("Travellers: 2");
		expect(asked[0]).toContain("241.00 EUR in total");
	});

	test("yes starts one booking; the same offer is not started twice", async () => {
		const { d, seen } = setup({ ask: async () => true });
		const r = await call(d, "book_flight", { ...BOOK, offer_id: "off_1", search_id: "s_yes" });
		expect(r.error).toBe(false);
		expect(JSON.parse(r.text).booking_ref).toBe("ref_1");
		const post = seen.find((s) => s.path.endsWith("/agent-book"));
		expect(post?.body).toMatchObject({
			search_id: "s_yes",
			offer_id: "off_1",
			contact_email: "a@example.com",
		});
		const again = await call(d, "book_flight", { ...BOOK, search_id: "s_yes" });
		expect(again.error).toBe(true);
		expect(seen.filter((s) => s.path.endsWith("/agent-book")).length).toBe(1);
	});

	test("an offer that is gone, or has no price, is never offered for a yes", async () => {
		for (const offers of [
			[],
			[{ ...OFFER, price: undefined }],
			[{ ...OFFER, currency: undefined }],
		]) {
			const { d, asked, seen } = setup({ offers });
			const r = await call(d, "book_flight", BOOK);
			expect(r.error).toBe(true);
			expect(asked).toEqual([]);
			expect(seen.some((s) => s.path.includes("agent-book"))).toBe(false);
		}
	});

	test("control characters from the service cannot reach the prompt", async () => {
		const { d, asked } = setup({
			offers: [{ ...OFFER, airline: "Evil\u001b[2J‮Air", route: "A\rB" }],
		});
		await call(d, "book_flight", BOOK);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
		expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/.test(asked[0])).toBe(false);
	});

	test("status lookup is read-only and needs no yes", async () => {
		const { d, seen, asked } = setup();
		const r = await call(d, "get_flight_booking", { booking_ref: "ref_1" });
		expect(JSON.parse(r.text).pnr).toBe("ABC123");
		expect(asked).toEqual([]);
		expect(seen[0].path).toBe("/api/agent-book/status");
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
		fs.cpSync(import.meta.dir, d, {
			recursive: true,
			filter: (s) => !s.endsWith(".test.ts"),
		});
		return d;
	};

	test("ships disabled: the prompt says No, nothing starts", async () => {
		const d = dir();
		await expect(startProcessExtension(d, { attended: true })).rejects.toThrow("disabled");
		expect(await enableExtension(d, "manifest.json", async () => false)).toBe(false);
		expect(await enableExtension(d)).toBe(false);
		expect(fs.existsSync(path.join(d, ".enabled"))).toBe(false);
	});

	test("enabled: tools list and a bad call fails before any request", async () => {
		const d = dir();
		expect(await enableExtension(d, "manifest.json", async () => true)).toBe(true);
		const ext = await startProcessExtension(d, { attended: true });
		try {
			expect(Object.keys(ext.tools).sort()).toEqual([
				"book_flight",
				"get_flight_booking",
				"get_flight_results",
				"search_flights",
			]);
			expect(await ext.tools.search_flights({ origin: "nope" })).toContain("origin");
			expect(await ext.tools.book_flight({ search_id: "x" })).toContain("offer_id");
		} finally {
			ext.close();
		}
	});
});
