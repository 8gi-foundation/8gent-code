import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineManager } from "./routines";
import {
	type ScoutFetch,
	consentHash,
	consentLine,
	fetchSource,
	runScout,
	scoutDir,
	validateScout,
} from "./scout";

const roots: string[] = [];
const home = () => {
	const d = mkdtempSync(join(tmpdir(), "scout-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;

const sources = [
	{ id: "gov", url: "https://www.gov.ie/en/feed/" },
	{ id: "news", url: "https://news.example.org/rss" },
];
const spec = { sources, keywords: ["AI", "procurement"] };

/** A fake network. Each handler answers one URL; every request is recorded. */
function net(routes: Record<string, () => Response | Promise<Response>>) {
	const calls: { url: string; init?: Parameters<ScoutFetch>[1] }[] = [];
	const fetchImpl: ScoutFetch = async (url, init) => {
		calls.push({ url, init });
		const h = routes[url];
		return h ? h() : new Response("not found", { status: 404 });
	};
	return { fetchImpl, calls };
}
const html = (t: string) => new Response(t, { status: 200 });

describe("scout schema", () => {
	test("a good spec is accepted as is", () => {
		expect(validateScout(spec)).toEqual(spec);
	});

	test("only https GET sources the person listed: http, userinfo, other ports, file and junk are refused", () => {
		for (const url of [
			"http://www.gov.ie/",
			"https://user:pw@www.gov.ie/",
			"https://www.gov.ie:8443/",
			"file:///etc/passwd",
			"ftp://x.example/",
			"javascript:alert(1)",
			"not a url",
			"",
		]) {
			expect(() => validateScout({ sources: [{ id: "a", url }], keywords: [] })).toThrow();
		}
	});

	test("ids, counts, sizes and unknown fields are bounded", () => {
		const ok = { id: "a", url: "https://a.example/" };
		expect(() => validateScout({ sources: [], keywords: [] })).toThrow();
		expect(() =>
			validateScout({
				sources: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, url: ok.url })),
				keywords: [],
			}),
		).toThrow();
		expect(() =>
			validateScout({ sources: [{ id: "Bad Id", url: ok.url }], keywords: [] }),
		).toThrow();
		expect(() => validateScout({ sources: [ok, ok], keywords: [] })).toThrow(/twice|duplicate/i);
		expect(() =>
			validateScout({ sources: [ok], keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }),
		).toThrow();
		expect(() => validateScout({ sources: [ok], keywords: ["x".repeat(81)] })).toThrow();
		expect(() => validateScout({ sources: [ok], keywords: [], notify: "telegram" })).toThrow();
		expect(() =>
			validateScout({ sources: [{ ...ok, headers: { cookie: "x" } }], keywords: [] }),
		).toThrow();
		expect(() => validateScout(null)).toThrow();
	});
});

describe("read-only source fetch", () => {
	const allow = new Set(["www.gov.ie", "news.example.org"]);

	test("a plain GET: no body, no credentials, no cookies, redirects handled by hand", async () => {
		const n = net({ "https://www.gov.ie/en/feed/": () => html("hello") });
		const r = await fetchSource(n.fetchImpl, "https://www.gov.ie/en/feed/", allow);
		expect(r).toEqual({ ok: true, text: "hello" });
		const init = n.calls[0].init as Record<string, unknown>;
		expect(init.method ?? "GET").toBe("GET");
		expect(init.body).toBeUndefined();
		expect(init.redirect).toBe("manual");
		expect(init.credentials).toBe("omit");
		const headers = Object.keys((init.headers as Record<string, string>) ?? {}).map((h) =>
			h.toLowerCase(),
		);
		expect(
			headers.some((h) => ["cookie", "authorization", "proxy-authorization"].includes(h)),
		).toBe(false);
	});

	test("a redirect to a host the person did not list is refused; to a listed host, followed", async () => {
		const bad = net({
			"https://www.gov.ie/en/feed/": () =>
				new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
		});
		const r = await fetchSource(bad.fetchImpl, "https://www.gov.ie/en/feed/", allow);
		expect(r.ok).toBe(false);
		expect(bad.calls.map((c) => c.url)).toEqual(["https://www.gov.ie/en/feed/"]);

		const good = net({
			"https://www.gov.ie/en/feed/": () =>
				new Response(null, { status: 301, headers: { location: "https://news.example.org/rss" } }),
			"https://news.example.org/rss": () => html("moved"),
		});
		expect(await fetchSource(good.fetchImpl, "https://www.gov.ie/en/feed/", allow)).toEqual({
			ok: true,
			text: "moved",
		});
	});

	test("a downgrade to http, a userinfo redirect and a redirect loop are refused", async () => {
		for (const loc of [
			"http://www.gov.ie/x",
			"https://u:p@www.gov.ie/x",
			"https://www.gov.ie/en/feed/",
		]) {
			const n = net({
				"https://www.gov.ie/en/feed/": () =>
					new Response(null, { status: 302, headers: { location: loc } }),
			});
			expect((await fetchSource(n.fetchImpl, "https://www.gov.ie/en/feed/", allow)).ok).toBe(false);
			expect(n.calls.length).toBeLessThanOrEqual(4);
		}
	});

	test("an oversized body is cut off and reported, a slow server times out, a 500 is a failure", async () => {
		const big = net({ "https://www.gov.ie/en/feed/": () => html("x".repeat(2_000)) });
		const r1 = await fetchSource(big.fetchImpl, "https://www.gov.ie/en/feed/", allow, {
			maxBytes: 1_000,
		});
		expect(r1.ok).toBe(false);
		const slow = net({ "https://www.gov.ie/en/feed/": () => new Promise<Response>(() => {}) });
		const t0 = Date.now();
		const r2 = await fetchSource(slow.fetchImpl, "https://www.gov.ie/en/feed/", allow, {
			timeoutMs: 100,
		});
		expect(r2.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(2_000);
		const down = net({ "https://www.gov.ie/en/feed/": () => new Response("no", { status: 500 }) });
		expect((await fetchSource(down.fetchImpl, "https://www.gov.ie/en/feed/", allow)).ok).toBe(
			false,
		);
	});
});

describe("running a scout", () => {
	const routine = { id: "ab12cd34", name: "morning", scout: spec };

	test("one failing source never stops the others; the result file is private and holds the matches", async () => {
		const h = home();
		const n = net({
			"https://www.gov.ie/en/feed/": () => new Response("no", { status: 503 }),
			"https://news.example.org/rss": () =>
				html(
					"<html><body><p>Cabinet approves AI procurement framework.</p><p>Weather today</p></body></html>",
				),
		});
		const t = new Date("2026-10-24T09:00:00.000Z");
		const r = await runScout(routine, {
			fetchImpl: n.fetchImpl,
			env: { EIGHT_HOME: h },
			now: () => t,
		});
		expect(r.status).toBe("completed");
		expect(n.calls.map((c) => c.url).sort()).toEqual([
			"https://news.example.org/rss",
			"https://www.gov.ie/en/feed/",
		]);
		const file = r.file as string;
		expect(file).toBe(join(scoutDir({ EIGHT_HOME: h }, "ab12cd34"), "2026-10-24T09-00-00-000Z.md"));
		expect(mode(file)).toBe(0o600);
		expect(mode(scoutDir({ EIGHT_HOME: h }, "ab12cd34"))).toBe(0o700);
		const text = readFileSync(file, "utf-8");
		expect(text).toContain("news");
		expect(text).toContain("Cabinet approves AI procurement framework.");
		expect(text).not.toContain("Weather today");
		expect(text).not.toContain("<p>");
		expect(text).toMatch(/gov[\s\S]*failed/i);
		expect(readdirSync(scoutDir({ EIGHT_HOME: h }, "ab12cd34"))).toEqual([
			"2026-10-24T09-00-00-000Z.md",
		]);
	});

	test("every source failing is a failed run, still with a result file saying why", async () => {
		const h = home();
		const n = net({});
		const r = await runScout(routine, { fetchImpl: n.fetchImpl, env: { EIGHT_HOME: h } });
		expect(r.status).toBe("failed");
		expect(existsSync(r.file as string)).toBe(true);
	});

	test("a spec outside the schema fetches nothing", async () => {
		const n = net({});
		const r = await runScout(
			{
				id: "x",
				name: "x",
				scout: { sources: [{ id: "a", url: "http://a.example/" }], keywords: [] },
			},
			{ fetchImpl: n.fetchImpl, env: { EIGHT_HOME: home() } },
		);
		expect(r.status).toBe("failed");
		expect(n.calls).toEqual([]);
	});

	test("the prompt and local content never go in a request: only the listed URLs are asked for", async () => {
		const n = net({
			"https://www.gov.ie/en/feed/": () => html("a"),
			"https://news.example.org/rss": () => html("b"),
		});
		await runScout(
			{ id: "x", name: "SECRET-NAME", scout: spec },
			{ fetchImpl: n.fetchImpl, env: { EIGHT_HOME: home() } },
		);
		for (const c of n.calls) {
			expect(sources.map((s) => s.url)).toContain(c.url);
			expect(JSON.stringify(c.init)).not.toContain("SECRET-NAME");
		}
	});
});

describe("consent: shown URLs, default No, unattended no", () => {
	const make = { name: "morning", schedule: "0 9 * * *", ...spec };

	test("the question lists every URL and ends [y/N]; a no or no-person saves nothing and fetches nothing", async () => {
		for (const answer of [false, null] as const) {
			const h = home();
			const asked: [string, boolean][] = [];
			const n = net({});
			const m = new RoutineManager(undefined, { EIGHT_HOME: h }, { fetchImpl: n.fetchImpl });
			const r = await m.createScout(make, async (line, d) => {
				asked.push([line, d]);
				return answer;
			});
			expect(r).toBeNull();
			expect(m.list()).toEqual([]);
			expect(asked.length).toBe(1);
			expect(asked[0][1]).toBe(false);
			expect(asked[0][0]).toContain("https://www.gov.ie/en/feed/");
			expect(asked[0][0]).toContain("https://news.example.org/rss");
			expect(asked[0][0]).toEndWith("[y/N]");
			expect(n.calls).toEqual([]);
			expect(existsSync(join(h, ".8gent", "routines.json"))).toBe(false);
		}
	});

	test("with no ask given, CI or no terminal means no", async () => {
		const h = home();
		const m = new RoutineManager(undefined, { EIGHT_HOME: h, CI: "1" }, {});
		expect(await m.createScout(make)).toBeNull();
		expect(m.list()).toEqual([]);
	});

	test("a yes saves an enabled scout carrying the consent hash of exactly those sources", async () => {
		const h = home();
		const m = new RoutineManager(undefined, { EIGHT_HOME: h }, {});
		const r = await m.createScout(make, async () => true);
		expect(r?.kind).toBe("scout");
		expect(r?.enabled).toBe(true);
		expect(r?.scout?.consent?.hash).toBe(consentHash(validateScout(spec)));
		expect(consentLine("morning", "0 9 * * *", validateScout(spec))).toContain("GET");
	});

	test("disable drops the consent; enabling asks again, and a no leaves it off", async () => {
		const h = home();
		const m = new RoutineManager(undefined, { EIGHT_HOME: h }, {});
		const r = (await m.createScout(make, async () => true)) as { id: string };
		m.disable(r.id);
		expect(m.get(r.id)?.scout?.consent).toBeUndefined();
		expect(await m.enableScout(r.id, async () => false)).toBe(false);
		expect(m.get(r.id)?.enabled).toBe(false);
		expect(await m.enableScout(r.id, async () => true)).toBe(true);
		expect(m.get(r.id)?.enabled).toBe(true);
	});

	test("the generic enable() cannot turn a scout on without a yes", async () => {
		const h = home();
		const m = new RoutineManager(undefined, { EIGHT_HOME: h }, {});
		const r = (await m.createScout(make, async () => true)) as { id: string };
		m.disable(r.id);
		m.enable(r.id);
		expect(m.get(r.id)?.enabled).toBe(false);
	});
});

describe("tick runs scouts in-process", () => {
	const make = { name: "morning", schedule: "0 9 * * *", ...spec };
	const at = new Date("2026-10-24T09:00:00.000Z");

	test("a due scout fetches only its listed URLs, writes its file, and records the pointer and status in history", async () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		const n = net({
			"https://www.gov.ie/en/feed/": () => html("AI news"),
			"https://news.example.org/rss": () => html("procurement news"),
		});
		const m = new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl });
		const r = (await m.createScout(make, async () => true)) as { id: string };
		// Pretend it was created a day earlier so today's 09:00 slot is due.
		const raw = JSON.parse(readFileSync(m.storePath, "utf-8"));
		raw[0].createdAt = "2026-10-23T08:00:00.000Z";
		writeFileSync(m.storePath, JSON.stringify(raw));
		const m2 = new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl });
		const runs = await m2.tick(at);
		expect(runs.length).toBe(1);
		expect(runs[0].status).toBe("completed");
		expect(runs[0].output).toBe(join(scoutDir(env, r.id), readdirSync(scoutDir(env, r.id))[0]));
		expect(n.calls.length).toBe(2);
		const saved = new RoutineManager(undefined, env).get(r.id);
		expect(saved?.history?.length).toBe(1);
		expect(saved?.history?.[0].output).toBe(runs[0].output);
		expect(JSON.stringify(saved?.history)).not.toContain("AI news");
	});

	test("a scout whose sources were edited after the yes is refused: nothing is fetched", async () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		const n = net({});
		const m = new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl });
		await m.createScout(make, async () => true);
		const raw = JSON.parse(readFileSync(m.storePath, "utf-8"));
		raw[0].createdAt = "2026-10-23T08:00:00.000Z";
		raw[0].scout.sources.push({ id: "extra", url: "https://tracker.example/" });
		writeFileSync(m.storePath, JSON.stringify(raw));
		const runs = await new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl }).tick(at);
		expect(runs.length).toBe(1);
		expect(runs[0].status).toBe("failed");
		expect(runs[0].error).toMatch(/agreed|changed/i);
		expect(n.calls).toEqual([]);
	});

	test("with kinds: ['scout'] a due ordinary routine is not run", async () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		const n = net({});
		const m = new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl });
		const plain = m.create({ name: "p", prompt: "do things", schedule: "0 9 * * *" });
		const raw = JSON.parse(readFileSync(m.storePath, "utf-8"));
		raw[0].createdAt = "2026-10-23T08:00:00.000Z";
		writeFileSync(m.storePath, JSON.stringify(raw));
		const m2 = new RoutineManager(undefined, env, { fetchImpl: n.fetchImpl });
		const runs = await m2.tick(at, { kinds: ["scout"] });
		expect(runs).toEqual([]);
		expect(m2.get(plain.id)?.history).toEqual([]);
		expect(m2.get(plain.id)?.lastRun).toBeUndefined();
	});
});
