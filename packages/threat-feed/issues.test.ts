import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDrafts, fileIssues, meetsMin, writeDrafts } from "./issues";
import type { Hit } from "./types";

const EM = String.fromCharCode(8212);
const hit = (o: Partial<Hit> = {}): Hit => ({
	repo: "o/r",
	package: "lodash",
	ecosystem: "npm",
	currentVersion: "4.17.15",
	fixedVersion: "4.17.19",
	severity: "HIGH",
	cvss: 7.4,
	onKev: false,
	kevCves: [],
	advisoryId: "GHSA-1",
	aliases: ["CVE-1"],
	advisoryUrl: "https://osv.dev/vulnerability/GHSA-1",
	summary: `has an em dash ${EM} and a user-agent`,
	files: ["bun.lock"],
	...o,
});

describe("buildDrafts", () => {
	test("one draft per repo per advisory, two versions share an issue", () => {
		const d = buildDrafts([
			hit(),
			hit({ currentVersion: "4.17.20" }),
			hit({ repo: "o/other" }),
			hit({ advisoryId: "GHSA-2" }),
		]);
		expect(d).toHaveLength(3);
		expect(d.find((x) => x.repo === "o/r" && x.advisoryId === "GHSA-1")?.body).toContain("4.17.20");
	});
	test("title is deterministic so reruns dedupe on exact title", () => {
		expect(buildDrafts([hit()])[0].title).toBe(buildDrafts([hit()])[0].title);
		expect(buildDrafts([hit({ onKev: true, kevCves: ["CVE-1"] })])[0].title).toContain(
			"known exploited",
		);
	});
	test("proposes the bump, opens no PR, copies no advisory prose, no em dash", () => {
		const b = buildDrafts([hit()])[0];
		expect(b.body).toContain("4.17.15 -> 4.17.19");
		expect(b.body).toContain("No PR opened");
		expect(b.body).not.toContain("user-agent");
		expect(`${b.title}${b.body}`).not.toContain(EM);
		expect(b.body.toLowerCase()).not.toMatch(/\bagent\b/);
	});
	test("missing fix is stated, not invented", () => {
		expect(buildDrafts([hit({ fixedVersion: null })])[0].body).toContain(
			"no fixed version listed upstream",
		);
	});
	test("min severity filters but never drops KEV", () => {
		expect(meetsMin(hit({ severity: "LOW" }), "HIGH")).toBe(false);
		expect(meetsMin(hit({ severity: "LOW", onKev: true }), "HIGH")).toBe(true);
	});
});

describe("filing", () => {
	test("writes gh-issue-file draft format and calls the runner once per repo", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-"));
		try {
			const drafts = writeDrafts(
				buildDrafts([hit(), hit({ advisoryId: "GHSA-2" }), hit({ repo: "o/x" })]),
				dir,
			);
			expect(fs.readFileSync(drafts[0].file, "utf8").split("\n").slice(0, 3)).toEqual([
				`# ${drafts[0].title}`,
				"Labels: security",
				"Owner: 8SO",
			]);
			const calls: [string, string[]][] = [];
			fileIssues(drafts, (r, f) => {
				calls.push([r, f]);
				return "ok";
			});
			expect(calls.map((c) => c[0]).sort()).toEqual(["o/r", "o/x"]);
			expect(calls.find((c) => c[0] === "o/r")?.[1]).toHaveLength(2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("refuses a repo name that is not owner/name", () => {
		const d = buildDrafts([hit({ repo: "o/r; rm -rf x" })]);
		expect(() => fileIssues(d, () => "")).toThrow("refusing repo name");
	});
});
