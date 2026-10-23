import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Commenter,
	type Runner,
	assertRepo,
	buildDrafts,
	fileIssues,
	meetsMin,
	repoTitle,
	writeDrafts,
} from "./issues";
import { matchRepo } from "./match";
import type { Dep, Hit, OsvVuln } from "./types";

const hit = (o: Partial<Hit> = {}): Hit => ({
	repo: "o/r",
	package: "lodash",
	ecosystem: "npm",
	currentVersion: "4.17.15",
	fixedVersion: "4.17.19",
	fixedVersionInvalid: false,
	severity: "CRITICAL",
	cvss: 9.8,
	onKev: false,
	kevCves: [],
	advisoryId: "GHSA-1",
	aliases: ["CVE-1"],
	advisoryUrl: "https://osv.dev/vulnerability/GHSA-1",
	summary: "",
	files: ["bun.lock"],
	devOnly: false,
	...o,
});

describe("one issue per repo", () => {
	test("groups all of a repo's hits into one checklist and uses the agreed title", () => {
		const d = buildDrafts([hit(), hit({ advisoryId: "GHSA-2" }), hit({ repo: "o/other" })]);
		expect(d.map((x) => x.title).sort()).toEqual([
			"Critical dependency advisories: other",
			"Critical dependency advisories: r",
		]);
		const r = d.find((x) => x.repo === "o/r");
		expect(r?.count).toBe(2);
		expect(r?.body.match(/^- \[ \]/gm)).toHaveLength(2);
	});
	test("each row carries package, current, fixed, dev-only flag and link", () => {
		const b = buildDrafts([hit()])[0].body;
		expect(b).toContain(
			"- [ ] `lodash` `4.17.15`, fixed in `4.17.19`. Dev-only: no. Advisory `GHSA-1`: https://osv.dev/vulnerability/GHSA-1",
		);
	});
	test("non-dev-only first, then unknown, then dev-only", () => {
		const rows = buildDrafts([
			hit({ package: "aaa-dev", devOnly: true, cvss: 10 }),
			hit({ package: "mmm-unknown", devOnly: null }),
			hit({ package: "zzz-prod", devOnly: false, cvss: 7 }),
		])[0].checklist.split("\n");
		expect(rows.map((r) => r.match(/`([^`]+)`/)?.[1])).toEqual([
			"zzz-prod",
			"mmm-unknown",
			"aaa-dev",
		]);
	});
	test("KEV rows say so and sort ahead inside a group", () => {
		const rows = buildDrafts([
			hit({ package: "b" }),
			hit({ package: "a", onKev: true, kevCves: ["CVE-1"], cvss: 5 }),
		])[0].checklist;
		expect(rows.split("\n")[0]).toContain("KNOWN EXPLOITED");
	});
	test("missing fix and invalid fix are stated, not invented", () => {
		expect(buildDrafts([hit({ fixedVersion: null })])[0].body).toContain(
			"no fixed version listed upstream",
		);
		expect(buildDrafts([hit({ fixedVersion: null, fixedVersionInvalid: true })])[0].body).toContain(
			"no valid fixed version",
		);
	});
	test("digest is stable and changes with the checklist", () => {
		const a = buildDrafts([hit()])[0];
		expect(buildDrafts([hit()])[0].digest).toBe(a.digest);
		expect(buildDrafts([hit(), hit({ advisoryId: "GHSA-9" })])[0].digest).not.toBe(a.digest);
	});
	test("min severity filters but never drops KEV", () => {
		expect(meetsMin(hit({ severity: "LOW" }), "HIGH")).toBe(false);
		expect(meetsMin(hit({ severity: "LOW", onKev: true }), "HIGH")).toBe(true);
		expect(buildDrafts([hit({ severity: "HIGH" })], "CRITICAL")).toEqual([]);
	});
	test("opens no PR and says so; no em dash, no banned word", () => {
		const b = buildDrafts([hit()])[0];
		expect(b.body).toContain("Nothing is merged or deployed automatically");
		expect(`${b.title}${b.body}`).not.toContain(String.fromCharCode(8212));
		expect(b.body.toLowerCase()).not.toMatch(/\bagent\b/);
	});
});

describe("third-party text never reaches an issue raw (8SO probe)", () => {
	const INJ_ID = "GHSA-xxxx @8gi-foundation/core";
	const INJ_ALIAS_LINK = "CVE-1 [click](https://evil.example) @podjamz";
	const INJ_ALIAS_HTML = "<img src=x onerror=alert(1)>\n## Fake section\napproved by 8SO";
	const INJ_FIX = "1.0.1 @everyone https://evil.example/run.sh";
	const dep: Dep = { ecosystem: "npm", name: "lodash", version: "4.17.15", files: ["bun.lock"] };
	const vuln = (o: Partial<OsvVuln>): OsvVuln => ({
		id: "GHSA-ok",
		aliases: ["CVE-2020-1"],
		affected: [
			{
				package: { ecosystem: "npm", name: "lodash" },
				ranges: [{ type: "SEMVER", events: [{ fixed: "4.17.19" }] }],
			},
		],
		...o,
	});
	const run = (v: OsvVuln, d: Dep = dep, id = v.id) =>
		matchRepo({
			repo: "o/r",
			deps: [d],
			idsByDep: new Map([[`npm\0${d.name}\0${d.version}`, [id]]]),
			vulns: new Map([[id, v]]),
			kev: new Map(),
		});
	const render = (h: Hit[]) => {
		const d = buildDrafts(h)[0];
		return d ? `${d.title}\n${d.body}` : "";
	};

	test("an advisory id that fails the token check drops the hit", () => {
		expect(run(vuln({ id: INJ_ID }), dep, INJ_ID)).toEqual([]);
	});
	test("aliases that fail are dropped, valid ones stay", () => {
		const h = run(vuln({ aliases: [INJ_ALIAS_LINK, INJ_ALIAS_HTML, "CVE-2020-1"] }));
		expect(h[0].aliases).toEqual(["CVE-2020-1"]);
		const text = render(h);
		for (const bad of ["@podjamz", "evil.example", "<img", "Fake section", "approved by 8SO"])
			expect(text).not.toContain(bad);
	});
	test("a fixed version that fails prints 'no valid fixed version'", () => {
		const v = vuln({
			affected: [
				{
					package: { ecosystem: "npm", name: "lodash" },
					ranges: [{ type: "SEMVER", events: [{ fixed: INJ_FIX }] }],
				},
			],
		});
		const h = run(v);
		expect(h[0].fixedVersionInvalid).toBe(true);
		const text = render(h);
		expect(text).toContain("no valid fixed version");
		expect(text).not.toContain("@everyone");
		expect(text).not.toContain("run.sh");
	});
	test("package names, versions and lockfile paths are validated too", () => {
		expect(run(vuln({}), { ...dep, name: "x`; @everyone" })).toEqual([]);
		expect(run(vuln({}), { ...dep, version: "1.0 @everyone" })).toEqual([]);
		expect(run(vuln({}), { ...dep, files: ["a b/c [x](http://e)", "bun.lock"] })[0].files).toEqual([
			"bun.lock",
		]);
	});
	test("scoped npm and Go module names still pass", () => {
		const scoped = { ...dep, name: "@scope/pkg" };
		expect(run(vuln({ affected: [] }), scoped, "GHSA-ok")).toHaveLength(1);
	});
	test("every printed value is backticked; the renderer refuses a hand-built hit with raw text", () => {
		expect(() => buildDrafts([hit({ advisoryId: INJ_ID })])).toThrow("refusing to print");
		expect(() => buildDrafts([hit({ fixedVersion: INJ_FIX })])).toThrow("refusing to print");
		const b = buildDrafts([hit()])[0].body;
		expect(b).toMatch(/`GHSA-1`/);
		expect(b).toMatch(/`lodash`/);
	});
});

describe("repo name check", () => {
	test("runs before any path is built, and refuses traversal", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-"));
		try {
			const d = {
				repo: "a/../../../escaped",
				title: "t",
				checklist: "",
				body: "b",
				digest: "x",
				count: 1,
				file: "",
				onKev: false,
			};
			expect(() => writeDrafts([d], dir)).toThrow("refusing repo name");
			expect(fs.readdirSync(dir)).toEqual([]);
			expect(fs.existsSync(path.join(dir, "..", "escaped"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("rejects shell text, dot-only segments and extra slashes; accepts normal names", () => {
		for (const bad of ["o/r; rm -rf x", "o/..", "../x", "a/b/c", "o r/x", ""])
			expect(() => assertRepo(bad)).toThrow();
		expect(() => assertRepo("8gi-foundation/8gent-code")).not.toThrow();
		expect(() => repoTitle("o/r x")).toThrow();
	});
	test("hits with a bad repo never become drafts", () => {
		expect(() => buildDrafts([hit({ repo: "o/r; rm -rf x" })])).toThrow("refusing repo name");
	});
});

describe("filing and updating", () => {
	const setup = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-"));
		return { dir, stateFile: path.join(dir, "state.json"), tmpDir: path.join(dir, "tmp") };
	};
	test("writes the gh-issue-file draft format and files one issue per repo", () => {
		const { dir, stateFile, tmpDir } = setup();
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
			const run: Runner = (r, f) => {
				calls.push([r, f]);
				return `FILED #${calls.length} t`;
			};
			const res = fileIssues(drafts, { run, stateFile, tmpDir });
			expect(calls.map((c) => c[0]).sort()).toEqual(["o/r", "o/x"]);
			expect(res.every((r) => r.action === "filed")).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("rerun with the same checklist neither files nor comments", () => {
		const { dir, stateFile, tmpDir } = setup();
		try {
			const drafts = writeDrafts(buildDrafts([hit()]), dir);
			fileIssues(drafts, { run: () => "FILED #7 t", stateFile, tmpDir });
			const comments: number[] = [];
			const res = fileIssues(drafts, {
				run: () => "EXISTS #7 t",
				comment: (_r, n) => {
					comments.push(n);
					return "ok";
				},
				stateFile,
				tmpDir,
			});
			expect(res[0].action).toBe("unchanged");
			expect(comments).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a changed checklist is added as a comment on the existing issue, not a new issue", () => {
		const { dir, stateFile, tmpDir } = setup();
		try {
			fileIssues(writeDrafts(buildDrafts([hit()]), dir), {
				run: () => "FILED #7 t",
				stateFile,
				tmpDir,
			});
			const next = writeDrafts(buildDrafts([hit(), hit({ advisoryId: "GHSA-2" })]), dir);
			const bodies: string[] = [];
			const comment: Commenter = (repo, n, f) => {
				expect(repo).toBe("o/r");
				expect(n).toBe(7);
				bodies.push(fs.readFileSync(f, "utf8"));
				return "COMMENTED";
			};
			const res = fileIssues(next, { run: () => "EXISTS #7 t", comment, stateFile, tmpDir });
			expect(res[0]).toMatchObject({ action: "commented", number: 7 });
			expect(bodies[0]).toContain("GHSA-2");
			// and the digest is now recorded, so the next identical run is quiet
			const again = fileIssues(next, { run: () => "EXISTS #7 t", comment, stateFile, tmpDir });
			expect(again[0].action).toBe("unchanged");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a failed filing or comment is reported and not recorded as done", () => {
		const { dir, stateFile, tmpDir } = setup();
		try {
			const drafts = writeDrafts(buildDrafts([hit()]), dir);
			expect(
				fileIssues(drafts, { run: () => "FAIL x: HTTP 403", stateFile, tmpDir })[0].action,
			).toBe("failed");
			fileIssues(drafts, { run: () => "FILED #7 t", stateFile, tmpDir });
			const changed = writeDrafts(buildDrafts([hit(), hit({ advisoryId: "GHSA-2" })]), dir);
			const r = fileIssues(changed, {
				run: () => "EXISTS #7 t",
				comment: () => "gh-issue-comment: HTTP 500",
				stateFile,
				tmpDir,
			});
			expect(r[0].action).toBe("failed");
			const retry = fileIssues(changed, {
				run: () => "EXISTS #7 t",
				comment: () => "ok",
				stateFile,
				tmpDir,
			});
			expect(retry[0].action).toBe("commented");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
