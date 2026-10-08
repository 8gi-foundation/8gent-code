/**
 * #3658: releases broken since 1 Oct. The three cases from the issue:
 *   (a) package.json 0.18.0 with tags v0.18.1 and v0.19.0 gives 0.19.1;
 *   (b) the CHANGELOG section lists the merged PR titles since the last tag;
 *   (c) no workflow pushes to main.
 * Plus the pure helpers and the CLI against a real git history that
 * reproduces the wedge: release tags on bump commits that never reached main.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bumpFromMarkers,
	nextVersion,
	parseBump,
	releaseBase,
	releaseVersions,
	setBinVersion,
	setPackageVersion,
	setReadmeBadge,
} from "./release-version";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

// The state on origin on 8 Oct 2026: the 0.x line, the two orphaned tags from
// 1 Oct, the pre-reset 1.x/2.x tags from March, and a non-release tag.
const ORIGIN_TAGS = [
	"v0.17.3",
	"v0.18.0",
	"v0.18.1",
	"v0.19.0",
	"v1.0.0",
	"v1.0.1",
	"v2.0.0",
	"v2.0.1",
	"v2.0.2",
	"v2.1.0",
	"desktop-v0.1.0",
];

describe("(a) nextVersion is computed past existing tags", () => {
	test("0.18.0 with v0.18.1 and v0.19.0 tagged gives 0.19.1 by default", () => {
		expect(nextVersion("0.18.0", ORIGIN_TAGS, "patch")).toBe("0.19.1");
	});
	test("[bump:minor] and [bump:major] still work from the same state", () => {
		expect(nextVersion("0.18.0", ORIGIN_TAGS, "minor")).toBe("0.20.0");
		// 1.0.0 and 1.0.1 exist from the old line, so the major release steps past them.
		expect(nextVersion("0.18.0", ORIGIN_TAGS, "major")).toBe("1.0.2");
	});
	test("tags from another major line never pull the version up", () => {
		expect(releaseBase("0.18.0", ORIGIN_TAGS)).toBe("0.19.0");
		expect(nextVersion("0.18.0", ["v2.1.0"], "patch")).toBe("0.18.1");
	});
	test("package.json ahead of every tag is the base", () => {
		expect(nextVersion("0.20.5", ORIGIN_TAGS, "patch")).toBe("0.20.6");
	});
	test("no tags at all: plain bump of package.json", () => {
		expect(nextVersion("0.18.0", [], "patch")).toBe("0.18.1");
		expect(nextVersion("0.18.0", [], "minor")).toBe("0.19.0");
	});
	test("a tag on the candidate itself is skipped", () => {
		expect(nextVersion("0.19.0", ["v0.19.0", "v0.19.1", "v0.19.2"], "patch")).toBe("0.19.3");
	});
	test("non-release tags and pre-releases are ignored", () => {
		expect(
			releaseVersions(["desktop-v0.1.0", "proxy-v9.9.9", "v1.2.3-beta.1", "v1.2.3", "1.2.4"]),
		).toEqual([[1, 2, 3]]);
	});
	test("a package.json version that is not X.Y.Z is an error", () => {
		expect(() => nextVersion("0.18", [], "patch")).toThrow("not X.Y.Z");
	});
});

describe("bump level", () => {
	test("markers in merged PR titles and bodies, major beats minor beats patch", () => {
		expect(bumpFromMarkers("fix: a (#1)\n\nfeat: b (#2)\n")).toBe("patch");
		expect(bumpFromMarkers("feat: b [bump:minor] (#2)\n")).toBe("minor");
		expect(bumpFromMarkers("fix: a [bump:minor]\nfeat!: c\nbody says [BUMP:MAJOR]\n")).toBe(
			"major",
		);
	});
	test("--bump auto or empty defers to the markers; anything else must be a level", () => {
		expect(parseBump(undefined)).toBeNull();
		expect(parseBump("auto")).toBeNull();
		expect(parseBump("Minor")).toBe("minor");
		expect(() => parseBump('x"; touch pwned; echo "')).toThrow("--bump must be");
	});
});

describe("version files", () => {
	test("package.json: only the top-level version changes, formatting kept", () => {
		const json =
			'{\n  "name": "x",\n  "version": "0.18.0",\n  "dependencies": { "yaml": "^2.9.1" }\n}\n';
		expect(setPackageVersion(json, "0.19.1")).toBe(json.replace('"0.18.0"', '"0.19.1"'));
		expect(() => setPackageVersion('{"name":"x"}', "1.0.0")).toThrow('no "version"');
	});
	test("bin/8gent.ts: the VERSION constant", () => {
		const ts = 'import x from "y";\n\nconst VERSION = "0.18.0";\n\nconst other = "0.18.0";\n';
		expect(setBinVersion(ts, "0.19.1")).toBe(
			'import x from "y";\n\nconst VERSION = "0.19.1";\n\nconst other = "0.18.0";\n',
		);
		expect(() => setBinVersion("const V = 1;\n", "1.0.0")).toThrow("const VERSION");
	});
	test("README badge: version and alt text; no badge is left alone", () => {
		const md =
			'<img src="https://img.shields.io/badge/version-0.18.0-2D8A56?style=for-the-badge" alt="v0.18.0" />\n';
		expect(setReadmeBadge(md, "0.19.1")).toBe(
			'<img src="https://img.shields.io/badge/version-0.19.1-2D8A56?style=for-the-badge" alt="v0.19.1" />\n',
		);
		expect(setReadmeBadge("# plain\n", "0.19.1")).toBe("# plain\n");
	});
});

/** A repo in the exact state that wedged the pipeline on 1 Oct. */
function wedgedRepo(): {
	dir: string;
	run: (args: string[]) => string;
	g: (...a: string[]) => string;
} {
	const dir = mkdtempSync(join(tmpdir(), "release-version-"));
	const run = (args: string[], env: Record<string, string> = {}) => {
		const r = spawnSync(args[0], args.slice(1), {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		if (r.status !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	let t = 1_700_000_000;
	const g = (...a: string[]) => {
		t += 60;
		const d = `${t} +0000`;
		return run(
			[
				"git",
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"tag.gpgsign=false",
				...a,
			],
			{ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d },
		);
	};
	const pkg = (v: string) => `{\n  "name": "x",\n  "version": "${v}"\n}\n`;
	g("init", "-q", "-b", "main");
	writeFileSync(join(dir, "package.json"), pkg("0.17.0"));
	writeFileSync(join(dir, "bin-8gent.ts"), 'const VERSION = "0.17.0";\n');
	writeFileSync(
		join(dir, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n### Fixed - hand-written before #3575\n- kept\n\n## [0.17.0] - 2026-09-01\n- prior\n",
	);
	g("add", "-A");
	g("commit", "-q", "-m", "chore: init");
	g("tag", "-a", "v2.1.0", "-m", "pre-reset line, higher version, older");
	writeFileSync(join(dir, "package.json"), pkg("0.18.0"));
	g("commit", "-q", "-am", "release: v0.18.0 (#3265)");
	g("tag", "-a", "v0.18.0", "-m", "v0.18.0");
	g("commit", "-q", "--allow-empty", "-m", "fix(a): shipped in 0.18.1 (#3301)");
	// auto-release tagged v0.18.1 on a bump commit that main rejected.
	g("checkout", "-q", "-b", "bump1");
	writeFileSync(join(dir, "package.json"), pkg("0.18.1"));
	g("commit", "-q", "-am", "chore(release): bump version to v0.18.1");
	g("tag", "-a", "v0.18.1", "-m", "Release v0.18.1");
	g("checkout", "-q", "main");
	g("commit", "-q", "--allow-empty", "-m", "feat(b): shipped in 0.19.0 (#3302)");
	g("checkout", "-q", "-b", "bump2");
	writeFileSync(join(dir, "package.json"), pkg("0.19.0"));
	g("commit", "-q", "-am", "chore(release): bump version to v0.19.0");
	g("tag", "-a", "v0.19.0", "-m", "Release v0.19.0");
	g("checkout", "-q", "main");
	// Everything since 1 Oct: squash merges and one merge commit.
	g("commit", "-q", "--allow-empty", "-m", "fix(mcp): follow redirects within the origin (#3635)");
	g("checkout", "-q", "-b", "topic");
	g("commit", "-q", "--allow-empty", "-m", "wip, not a PR title");
	g("checkout", "-q", "main");
	g(
		"merge",
		"-q",
		"--no-ff",
		"topic",
		"-m",
		"Merge pull request #3624 from org/topic",
		"-m",
		"fix(daemon): close the approval loop",
	);
	return { dir, run, g };
}

const RELEASE_VERSION = join(ROOT, "scripts", "release-version.ts");
const CHANGELOG_RELEASE = join(ROOT, "scripts", "changelog-release.ts");

describe("CLI against the wedged history", () => {
	test("(a) next is 0.19.1; [bump:minor] in a later PR gives 0.20.0; --bump overrides", () => {
		const { dir, run, g } = wedgedRepo();
		try {
			expect(run([process.execPath, RELEASE_VERSION, "current"]).trim()).toBe("0.18.0");
			expect(run([process.execPath, RELEASE_VERSION, "next"]).trim()).toBe("0.19.1");
			expect(run([process.execPath, RELEASE_VERSION, "next", "--bump", "major"]).trim()).toBe(
				"1.0.0",
			);
			g("commit", "-q", "--allow-empty", "-m", "feat(tui): new pane [bump:minor] (#3640)");
			expect(run([process.execPath, RELEASE_VERSION, "next"]).trim()).toBe("0.20.0");
			expect(run([process.execPath, RELEASE_VERSION, "next", "--bump", "patch"]).trim()).toBe(
				"0.19.1",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(b) the CHANGELOG section lists the PR titles merged since the last tag, nothing older", () => {
		const { dir, run } = wedgedRepo();
		try {
			const out = run([
				process.execPath,
				CHANGELOG_RELEASE,
				"--version",
				"0.19.1",
				"--date",
				"2026-10-08",
				"--write",
				"--keep-unreleased",
			]);
			expect(out).toContain("## [0.19.1] - 2026-10-08");
			expect(out).toContain("- mcp: follow redirects within the origin ([#3635]");
			expect(out).toContain("- daemon: close the approval loop ([#3624]");
			expect(out).not.toContain("shipped in 0.19.0");
			expect(out).not.toContain("shipped in 0.18.1");
			expect(out).not.toContain("wip, not a PR title");
			expect(out).not.toContain("bump version");
			const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
			expect(changelog.indexOf("## [Unreleased]")).toBeLessThan(changelog.indexOf("## [0.19.1]"));
			expect(changelog.indexOf("## [0.19.1]")).toBeLessThan(changelog.indexOf("## [0.17.0]"));
			// Hand-written notes from before #3575 are kept inside the release, not lost.
			expect(changelog.indexOf("## [0.19.1]")).toBeLessThan(
				changelog.indexOf("hand-written before #3575"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("apply writes the version files; commit finds where a version landed on main", () => {
		const { dir, run, g } = wedgedRepo();
		try {
			// The fixture has no bin/8gent.ts or README.md; give it the real shapes.
			mkdirSync(join(dir, "bin"));
			writeFileSync(join(dir, "bin", "8gent.ts"), 'const VERSION = "0.18.0";\n');
			writeFileSync(
				join(dir, "README.md"),
				'<img src="https://img.shields.io/badge/version-0.18.0-2D8A56" alt="v0.18.0" />\n',
			);
			run([process.execPath, RELEASE_VERSION, "apply", "0.19.1"]);
			expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.19.1");
			expect(readFileSync(join(dir, "bin", "8gent.ts"), "utf8")).toBe(
				'const VERSION = "0.19.1";\n',
			);
			expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("version-0.19.1-");
			expect(readFileSync(join(dir, "README.md"), "utf8")).toContain('alt="v0.19.1"');

			g("add", "-A");
			g("commit", "-q", "-m", "release: v0.19.1 (#3700)");
			const releaseCommit = g("rev-parse", "HEAD").trim();
			// A later unrelated merge must not move the tag target.
			g("commit", "-q", "--allow-empty", "-m", "fix: after the release (#3701)");
			expect(run([process.execPath, RELEASE_VERSION, "commit", "0.19.1"]).trim()).toBe(
				releaseCommit,
			);
			const r = spawnSync(process.execPath, [RELEASE_VERSION, "commit", "9.9.9"], {
				cwd: dir,
				encoding: "utf8",
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("no first-parent commit");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("(c) no workflow pushes to main", () => {
	const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	const DIRECT_PUSH =
		/git\s+push\b[^\n]*\s(origin|upstream)\s+(--[a-z-]+\s+)*(\S+:)?(refs\/heads\/)?main\b/;

	test("every workflow is free of `git push ... main`", () => {
		const offenders = files.filter((f) =>
			DIRECT_PUSH.test(readFileSync(join(WORKFLOWS, f), "utf8")),
		);
		expect(offenders).toEqual([]);
	});
	test("the two workflows that pushed to main are gone, replaced by release-pr.yml", () => {
		expect(existsSync(join(WORKFLOWS, "auto-release.yml"))).toBe(false);
		expect(existsSync(join(WORKFLOWS, "version-bump-on-main.yml"))).toBe(false);
		const wf = readFileSync(join(WORKFLOWS, "release-pr.yml"), "utf8");
		expect(wf).toContain("release/next");
		expect(wf).toContain("gh pr create");
		expect(wf).toContain("scripts/release-version.ts next");
		expect(wf).toContain("scripts/changelog-release.ts");
	});
	test("the publish workflows can be started by the tag job (a GITHUB_TOKEN tag push does not trigger them)", () => {
		for (const f of ["release.yml", "release-binaries.yml"]) {
			expect(readFileSync(join(WORKFLOWS, f), "utf8")).toMatch(/^\s*workflow_dispatch:/m);
		}
	});
});
