import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Fetch, ingest, isEventId, parseManifest } from "./ingest";
import { CIRCL_OSINT, makeSource, parseSourceFlag } from "./source";

const A = "55b7c901-614c-44d1-a638-440e950d210b";
const B = "55b7c901-614c-44d1-a638-440e950d210c";
const C = "55b7c901-614c-44d1-a638-440e950d210d";
const manifest = {
	[A]: { info: "old", timestamp: 100 },
	[B]: { info: "new", timestamp: 300 },
	[C]: { info: "mid", timestamp: 200 },
	"../../etc/passwd": { info: "evil", timestamp: 999 },
};

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "misp-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fake(seen: { url: string; auth?: string; method?: string }[]): Fetch {
	return async (url, init) => {
		seen.push({
			url,
			auth: (init?.headers as Record<string, string>)?.authorization,
			method: init?.method,
		});
		if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(manifest));
		return new Response(
			JSON.stringify({ Event: { uuid: url.split("/").pop()?.replace(".json", "") } }),
		);
	};
}

describe("manifest", () => {
	test("keeps only uuid keys, so a hostile key never becomes a path", () => {
		expect([...parseManifest(manifest).keys()].sort()).toEqual([A, B, C]);
		expect(isEventId("../x")).toBe(false);
	});
	test("rejects non-objects and empty manifests", () => {
		expect(() => parseManifest([])).toThrow();
		expect(() => parseManifest({ x: {} })).toThrow();
	});
});

describe("ingest", () => {
	test("stores the manifest and the newest N events, counts the whole manifest", async () => {
		const seen: { url: string }[] = [];
		const r = await ingest(CIRCL_OSINT, {
			storeRoot: tmp,
			maxEvents: 2,
			fetch: fake(seen),
			now: new Date("2026-10-23T00:00:00Z"),
		});
		expect(r).toMatchObject({ manifestEvents: 3, stored: 2, alreadyStored: 0, failed: [] });
		expect(fs.readdirSync(path.join(tmp, "circl-osint/events")).sort()).toEqual([
			`${B}.json`,
			`${C}.json`,
		]);
		expect(fs.existsSync(path.join(tmp, "circl-osint/manifest.json"))).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(path.join(tmp, "circl-osint/ingest.json"), "utf8")).fetchedAt,
		).toBe("2026-10-23T00:00:00.000Z");
	});
	test("0 means manifest only", async () => {
		const seen: { url: string }[] = [];
		const r = await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 0, fetch: fake(seen) });
		expect(seen).toHaveLength(1);
		expect(r.stored).toBe(0);
	});
	test("a rerun fetches nothing new for unchanged events", async () => {
		await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 2, fetch: fake([]) });
		const seen: { url: string }[] = [];
		const r = await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 2, fetch: fake(seen) });
		expect(seen).toHaveLength(1);
		expect(r).toMatchObject({ stored: 0, alreadyStored: 2 });
	});
	test("read-only: GET only", async () => {
		const seen: { url: string; method?: string }[] = [];
		await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 1, fetch: fake(seen) });
		expect(seen.every((s) => !s.method || s.method === "GET")).toBe(true);
	});
	test("one bad event is recorded as failed, the rest still land", async () => {
		const f: Fetch = async (url) =>
			url.endsWith("/manifest.json")
				? new Response(JSON.stringify(manifest))
				: url.includes(B)
					? new Response("", { status: 500 })
					: new Response("{}");
		const r = await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 3, fetch: f });
		expect(r.failed).toEqual([B]);
		expect(r.stored).toBe(2);
	});
	test("manifest failure throws with the status", async () => {
		await expect(
			ingest(CIRCL_OSINT, { storeRoot: tmp, fetch: async () => new Response("", { status: 403 }) }),
		).rejects.toThrow("HTTP 403");
	});
});

describe("pluggable source with auth from env", () => {
	const env = { THREAT_FEED_MISP_OURS_KEY: "k-123" };
	test("key is read from env and sent as the Authorization header only to that source", async () => {
		const s = makeSource("ours", "https://misp.example/feed/", env);
		expect(s.baseUrl).toBe("https://misp.example/feed");
		const seen: { url: string; auth?: string }[] = [];
		await ingest(s, { storeRoot: tmp, maxEvents: 1, fetch: fake(seen) });
		expect(seen.every((x) => x.auth === "k-123")).toBe(true);
		expect(seen[0].url).toBe("https://misp.example/feed/manifest.json");
		expect(fs.readFileSync(path.join(tmp, "ours/ingest.json"), "utf8")).not.toContain("k-123");
	});
	test("no key means no Authorization header (CIRCL)", async () => {
		const seen: { url: string; auth?: string }[] = [];
		await ingest(CIRCL_OSINT, { storeRoot: tmp, maxEvents: 0, fetch: fake(seen) });
		expect(seen[0].auth).toBeUndefined();
	});
	test("refuses a key over plain http and a bad name", () => {
		expect(() => makeSource("ours", "http://misp.example/feed", env)).toThrow("https");
		expect(() => makeSource("../x", "https://a.b", {})).toThrow("bad source name");
	});
	test("--source flag parses name=url", () => {
		expect(parseSourceFlag("ours=https://misp.example/f", env).authKey).toBe("k-123");
		expect(() => parseSourceFlag("nourl", {})).toThrow();
	});
});
