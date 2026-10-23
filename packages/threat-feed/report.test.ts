import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fetch } from "./feeds";
import { run } from "./index";
import { buildReport, renderMarkdown } from "./report";

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dir, "fixtures", n), "utf8");
const NOW = new Date("2026-10-23T12:00:00Z");

describe("report", () => {
	test("counts, ranks and notes coverage gaps", () => {
		const r = buildReport(
			[
				{
					repo: "o/r",
					deps: [],
					lockfiles: [],
					skipped: ["bun.lockb: binary bun lockfile, not parsed"],
				},
			],
			[],
			{ osvVulnsFetched: 0, osvVulnsFailed: ["X"], kevEntries: 2 },
			NOW,
		);
		expect(r.totals).toEqual({ repos: 1, deps: 0, hits: 0, kevHits: 0 });
		const md = renderMarkdown(r);
		expect(md).toContain("# Threat feed report 2026-10-23");
		expect(md).toContain("o/r: bun.lockb");
		expect(md).toContain("failed for 1 advisories");
	});
});

describe("end to end with fixture feeds, no network", () => {
	test("dry run writes report.json and summary.md and files nothing", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-run-"));
		try {
			const manifest = path.join(tmp, "eco.json");
			fs.writeFileSync(
				manifest,
				JSON.stringify({ org: "o", repos: [{ name: "r", status: "active" }] }),
			);
			const urls: string[] = [];
			const f: Fetch = async (url, init) => {
				urls.push(url);
				if (url.includes("/git/trees/"))
					return new Response(
						JSON.stringify({ tree: [{ path: "bun.lock", type: "blob", sha: "s1", size: 1 }] }),
					);
				if (url.includes("/git/blobs/")) return new Response(fx("bun.lock"));
				if (url.endsWith("/v1/querybatch")) {
					const q = JSON.parse(String(init?.body)).queries as { package: { name: string } }[];
					return new Response(
						JSON.stringify({
							results: q.map((x) =>
								x.package.name === "lodash" ? { vulns: [{ id: "GHSA-p6mc-m468-83gw" }] } : {},
							),
						}),
					);
				}
				if (url.includes("/v1/vulns/")) return new Response(fx("osv-lodash.json"));
				if (url.includes("known_exploited")) return new Response(fx("kev.json"));
				return new Response("", { status: 404 });
			};
			let filed = false;
			const out = await run({
				manifestPath: manifest,
				outRoot: path.join(tmp, "out"),
				fileIssues: false,
				minSeverity: "UNKNOWN",
				token: "t",
				fetch: f,
				now: NOW,
				runner: () => {
					filed = true;
					return "";
				},
			});
			expect(filed).toBe(false);
			expect(out.report.totals).toMatchObject({ hits: 1, kevHits: 1 });
			expect(out.paths.json).toContain("2026-10-23/report.json");
			const saved = JSON.parse(fs.readFileSync(out.paths.json, "utf8"));
			expect(saved.hits[0]).toMatchObject({
				repo: "o/r",
				package: "lodash",
				currentVersion: "4.17.15",
				fixedVersion: "4.17.19",
				onKev: true,
			});
			expect(fs.readFileSync(out.paths.md, "utf8")).toContain("GHSA-p6mc-m468-83gw");
			expect(fs.readFileSync(out.paths.json, "utf8")).not.toContain("Bearer");
			expect(fs.existsSync(path.join(tmp, "out/2026-10-23/issues"))).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("--file-issues path writes drafts and calls the runner", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-run2-"));
		try {
			const manifest = path.join(tmp, "eco.json");
			fs.writeFileSync(manifest, JSON.stringify({ org: "o", repos: [{ name: "r" }] }));
			const f: Fetch = async (url, init) => {
				if (url.includes("/git/trees/"))
					return new Response(
						JSON.stringify({ tree: [{ path: "bun.lock", type: "blob", sha: "s1", size: 1 }] }),
					);
				if (url.includes("/git/blobs/")) return new Response(fx("bun.lock"));
				if (url.endsWith("/v1/querybatch")) {
					const q = JSON.parse(String(init?.body)).queries as { package: { name: string } }[];
					return new Response(
						JSON.stringify({
							results: q.map((x) =>
								x.package.name === "lodash" ? { vulns: [{ id: "GHSA-p6mc-m468-83gw" }] } : {},
							),
						}),
					);
				}
				if (url.includes("/v1/vulns/")) return new Response(fx("osv-lodash.json"));
				return new Response(fx("kev.json"));
			};
			const calls: string[] = [];
			const out = await run({
				manifestPath: manifest,
				outRoot: tmp,
				fileIssues: true,
				minSeverity: "UNKNOWN",
				token: "t",
				fetch: f,
				now: NOW,
				runner: (r) => {
					calls.push(r);
					return "FILED #1 t";
				},
			});
			expect(calls).toEqual(["o/r"]);
			expect(out.report.mode).toBe("file-issues");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
