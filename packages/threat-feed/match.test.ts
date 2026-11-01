import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseKev } from "./feeds";
import {
	bucket,
	compareVersions,
	cvss3Base,
	depKey,
	fixedVersionFor,
	matchRepo,
	rankHits,
	severityOf,
} from "./match";
import type { Dep, OsvVuln } from "./types";

const fx = <T>(n: string) =>
	JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", n), "utf8")) as T;
const lodashVuln = fx<OsvVuln>("osv-lodash.json");
const axiosVuln = fx<OsvVuln>("osv-axios.json");
const kev = parseKev(fx("kev.json"));
const dep = (name: string, version: string): Dep => ({
	ecosystem: "npm",
	name,
	version,
	files: ["bun.lock"],
});

describe("version compare and fix selection", () => {
	test("orders dotted versions numerically", () => {
		expect(compareVersions("4.17.9", "4.17.19")).toBe(-1);
		expect(compareVersions("v1.2", "1.2.0")).toBe(0);
	});
	test("picks the smallest fix above the current version, not an unrelated range", () => {
		expect(fixedVersionFor(lodashVuln, dep("lodash", "4.17.15"))).toBe("4.17.19");
	});
	test("returns null when no listed fix is above current", () => {
		expect(fixedVersionFor(lodashVuln, dep("lodash", "9.0.0"))).toBeNull();
	});
	test("ignores affected entries for other packages", () => {
		expect(fixedVersionFor(lodashVuln, dep("other", "1.0.0"))).toBeNull();
	});
});

describe("severity", () => {
	test("computes CVSS 3.1 base score from the vector", () => {
		expect(cvss3Base("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
		expect(cvss3Base("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H")).toBe(7.4);
		expect(cvss3Base("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
	});
	test("rejects v4 and junk vectors rather than guessing", () => {
		expect(cvss3Base("CVSS:4.0/AV:N")).toBeNull();
		expect(cvss3Base("nonsense")).toBeNull();
	});
	test("vector wins, GHSA label is the fallback, MODERATE maps to MEDIUM", () => {
		expect(severityOf(lodashVuln)).toEqual({ severity: "HIGH", cvss: 7.4 });
		expect(severityOf(axiosVuln)).toEqual({ severity: "MEDIUM", cvss: null });
		expect(severityOf({ id: "X" })).toEqual({ severity: "UNKNOWN", cvss: null });
		expect(bucket(9.1)).toBe("CRITICAL");
	});
});

describe("matchRepo", () => {
	const deps = [dep("lodash", "4.17.15"), dep("axios", "0.21.1"), dep("clean", "1.0.0")];
	const idsByDep = new Map([
		[depKey(deps[0]), [lodashVuln.id]],
		[depKey(deps[1]), [axiosVuln.id]],
	]);
	const vulns = new Map([
		[lodashVuln.id, lodashVuln],
		[axiosVuln.id, axiosVuln],
	]);
	const hits = matchRepo({ repo: "o/r", deps, idsByDep, vulns, kev });

	test("one hit per dep and advisory, none for a clean dep", () => {
		expect(hits.map((h) => h.package).sort()).toEqual(["axios", "lodash"]);
	});
	test("records every field the report promises", () => {
		const h = hits.find((x) => x.package === "lodash");
		expect(h).toMatchObject({
			repo: "o/r",
			currentVersion: "4.17.15",
			fixedVersion: "4.17.19",
			severity: "HIGH",
			onKev: true,
			kevCves: ["CVE-2020-8203"],
			advisoryUrl: "https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw",
		});
	});
	test("KEV is matched through aliases, and a non-KEV advisory stays false", () => {
		expect(hits.find((x) => x.package === "axios")?.onKev).toBe(false);
	});
	test("ranking puts KEV first even over a higher severity", () => {
		expect(rankHits(hits).map((h) => h.package)).toEqual(["lodash", "axios"]);
	});
	test("an advisory id with no fetched record is skipped, not invented", () => {
		const m = new Map([[depKey(deps[0]), ["GHSA-missing"]]]);
		expect(matchRepo({ repo: "o/r", deps, idsByDep: m, vulns, kev })).toEqual([]);
	});
});
