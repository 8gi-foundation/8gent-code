import { describe, expect, test } from "bun:test";
import { type Fetch, fetchKev, fetchVulns, parseKev, queryOsv } from "./feeds";
import type { Dep } from "./types";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const d = (name: string, version: string): Dep => ({ ecosystem: "npm", name, version, files: [] });

describe("queryOsv", () => {
	test("sends one deduped batch and maps results back by position", async () => {
		const calls: { queries: unknown[] }[] = [];
		const f: Fetch = async (_u, init) => {
			const body = JSON.parse(String(init?.body));
			calls.push(body);
			return json({
				results: body.queries.map((_: unknown, i: number) =>
					i === 0 ? { vulns: [{ id: "GHSA-1" }] } : {},
				),
			});
		};
		const m = await queryOsv([d("a", "1.0.0"), d("a", "1.0.0"), d("b", "2.0.0")], f);
		expect(calls).toHaveLength(1);
		expect(calls[0].queries).toHaveLength(2);
		expect(m.get("npm\0a\0" + "1.0.0")).toEqual(["GHSA-1"]);
		expect(m.get("npm\0b\0" + "2.0.0")).toEqual([]);
	});
	test("follows next_page_token for the query that has one", async () => {
		let n = 0;
		const bodies: any[] = [];
		const f: Fetch = async (_u, init) => {
			const b = JSON.parse(String(init?.body));
			bodies.push(b);
			n++;
			return json({
				results: [
					n === 1 ? { vulns: [{ id: "A" }], next_page_token: "t" } : { vulns: [{ id: "B" }] },
				],
			});
		};
		const m = await queryOsv([d("a", "1.0.0")], f);
		expect(bodies[1].queries[0].page_token).toBe("t");
		expect(m.get("npm\0a\0" + "1.0.0")).toEqual(["A", "B"]);
	});
	test("a mismatched result count is an error, not silent loss", async () => {
		const f: Fetch = async () => json({ results: [] });
		await expect(queryOsv([d("a", "1.0.0")], f)).rejects.toThrow("mismatch");
	});
	test("an HTTP error names the call", async () => {
		const f: Fetch = async () => json({}, 500);
		await expect(queryOsv([d("a", "1.0.0")], f)).rejects.toThrow("osv querybatch: HTTP 500");
	});
});

describe("fetchVulns", () => {
	test("dedupes ids and reports failures without throwing", async () => {
		const seen: string[] = [];
		const f: Fetch = async (u) => {
			seen.push(u);
			return u.endsWith("BAD") ? json({}, 404) : json({ id: u.split("/").pop() });
		};
		const r = await fetchVulns(["X", "X", "BAD"], f);
		expect(seen).toHaveLength(2);
		expect([...r.vulns.keys()]).toEqual(["X"]);
		expect(r.failed).toEqual(["BAD"]);
	});
});

describe("KEV", () => {
	test("parses entries by CVE id", () => {
		expect(parseKev({ vulnerabilities: [{ cveID: "CVE-1" }, {}] }).size).toBe(1);
	});
	test("rejects a document with no list", () => {
		expect(() => parseKev({})).toThrow();
	});
	test("fetchKev surfaces HTTP failure", async () => {
		await expect(fetchKev(async () => json({}, 503))).rejects.toThrow("cisa kev: HTTP 503");
	});
});
