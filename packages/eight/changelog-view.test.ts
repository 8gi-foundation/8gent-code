import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changelogOutput,
	formatSections,
	latestSections,
	loadChangelog,
	parseChangelog,
	readBundledChangelog,
	sanitizeForDisplay,
	sectionsSince,
} from "./changelog-view.js";

const MD = `# Changelog

## [Unreleased]
- wip

## [0.9.0] - 2026-09-01
### Added
- nine

## [0.10.0] - 2026-10-01
- ten

## [0.8.1] - 2026-08-01
- old

## Notes
ignored
`;

describe("changelog-view", () => {
	test("parses version sections newest first, skipping Unreleased and other headings", () => {
		const s = parseChangelog(MD);
		expect(s.map((x) => x.version)).toEqual(["0.10.0", "0.9.0", "0.8.1"]);
		expect(s[1].heading).toBe("- 2026-09-01");
		expect(s[1].body).toContain("- nine");
		expect(s[1].body).not.toContain("ten");
		expect(s[2].body).not.toContain("ignored");
	});
	test("sectionsSince compares numerically and excludes the given version", () => {
		const s = parseChangelog(MD);
		expect(sectionsSince(s, "0.9.0").map((x) => x.version)).toEqual(["0.10.0"]);
		expect(sectionsSince(s, "0.8.0").length).toBe(3);
		expect(sectionsSince(s, "1.0.0")).toEqual([]);
		expect(sectionsSince(s, "garbage")).toEqual([]);
	});
	test("latestSections and formatSections", () => {
		const s = parseChangelog(MD);
		expect(latestSections(s, 2).map((x) => x.version)).toEqual(["0.10.0", "0.9.0"]);
		expect(latestSections(s, 0)).toEqual([]);
		expect(formatSections(latestSections(s, 2))).toContain("## [0.9.0]");
	});
	test("loads the real CHANGELOG that ships with the repo", () => {
		const s = loadChangelog();
		expect(s.length).toBeGreaterThan(0);
		expect(s[0].body.startsWith("## [")).toBe(true);
	});
	test("a folder with no changelog gives []", () => {
		expect(loadChangelog("/nonexistent-dir-xyz")).toEqual([]);
	});
});

describe("sanitizeForDisplay", () => {
	test("strips escape sequences and control characters, keeps text, newlines and tabs", () => {
		const evil = "ok\x1b[2J\x1b]0;pwned\x07 line\r\nnext\ttab\x00\x08\x9b";
		expect(sanitizeForDisplay(evil)).toBe("ok line\nnext\ttab");
		expect(formatSections([{ version: "1.0.0", heading: "", body: "## [1.0.0]\n\x1b[31mred\x1b[0m" }])).toBe("## [1.0.0]\nred");
	});
});

const CMD_FILE = [
	"# Changelog",
	"",
	"---",
	"",
	"## [Unreleased]",
	"",
	"## [0.20.45] - 2026-11-10",
	"",
	"### Fixed",
	"- the forty-five fix",
	"",
	"## [0.20.4] - 2026-10-01",
	"",
	"### Added",
	"- the four entry",
	"",
	"---",
	"",
	"## [0.20.3] - 2026-09-30",
	"- the three entry",
].join("\n");

describe("changelogOutput (/changelog)", () => {
	test("section for an exact version, heading line first", () => {
		expect(changelogOutput(CMD_FILE, "0.20.45", "0.0.0")).toBe("## [0.20.45] - 2026-11-10\n\n### Fixed\n- the forty-five fix");
	});
	test("a leading v is the same version", () => {
		expect(changelogOutput(CMD_FILE, "v0.20.45", "0.0.0")).toBe(changelogOutput(CMD_FILE, "0.20.45", "0.0.0"));
	});
	test("no argument uses the installed version", () => {
		expect(changelogOutput(CMD_FILE, undefined, "0.20.3")).toBe("## [0.20.3] - 2026-09-30\n- the three entry");
	});
	test("a version not in the file is one plain line, with no fallback", () => {
		expect(changelogOutput(CMD_FILE, "0.20.46", "0.20.45")).toBe("No changelog entry for v0.20.46.");
		expect(changelogOutput(CMD_FILE, undefined, "9.9.9")).toBe("No changelog entry for v9.9.9.");
	});
	test("a missing changelog is one plain line", () => {
		expect(changelogOutput(null, undefined, "0.20.45")).toBe("No changelog file found.");
		expect(changelogOutput(null, "all", "0.20.45")).toBe("No changelog file found.");
	});
	test("all lists the version headings, not Unreleased", () => {
		expect(changelogOutput(CMD_FILE, "all", "0.20.45")).toBe(
			["## [0.20.45] - 2026-11-10", "## [0.20.4] - 2026-10-01", "## [0.20.3] - 2026-09-30"].join("\n"),
		);
	});
	test("0.20.4 never matches 0.20.45, either way round", () => {
		const four = changelogOutput(CMD_FILE, "0.20.4", "0.0.0");
		expect(four).toContain("the four entry");
		expect(four).not.toContain("forty-five");
		expect(changelogOutput("## [0.20.45] - x\n- a\n", "0.20.4", "0.0.0")).toBe("No changelog entry for v0.20.4.");
	});
	test("a trailing separator is not part of the section", () => {
		expect(changelogOutput(CMD_FILE, "0.20.4", "0.0.0").endsWith("- the four entry")).toBeTrue();
	});
	test("escape sequences in a changelog line are stripped before display", () => {
		const evil = "## [1.0.0] - x\n- red \x1b[31mtext\x1b[0m \x1b]0;pwned\x07done\x1b[2J\n\n## [0.9.0] - y\n- ok";
		const out = changelogOutput(evil, "1.0.0", "0.0.0");
		expect(out).toBe("## [1.0.0] - x\n- red text done");
		expect(changelogOutput("## [1.0.0] - \x1b[2Jx", "all", "0.0.0")).toBe("## [1.0.0] - x");
	});
});

describe("readBundledChangelog (file on disk vs embedded in the build)", () => {
	const g = globalThis as Record<string, unknown>;
	test("embedded text is used when no CHANGELOG.md is on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "chlog-"));
		const prev = g.__EIGHT_EMBEDDED_CHANGELOG;
		try {
			const embedded = join(dir, "embedded.md");
			writeFileSync(embedded, "## [7.7.7] - embedded\n- from the build\n");
			g.__EIGHT_EMBEDDED_CHANGELOG = embedded;
			expect(readBundledChangelog("/nonexistent-dir-xyz")).toContain("from the build");
			expect(changelogOutput(readBundledChangelog("/nonexistent-dir-xyz"), "7.7.7", "0.0.0")).toBe("## [7.7.7] - embedded\n- from the build");
		} finally {
			if (prev === undefined) delete g.__EIGHT_EMBEDDED_CHANGELOG;
			else g.__EIGHT_EMBEDDED_CHANGELOG = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("nothing embedded and nothing on disk gives null", () => {
		const prev = g.__EIGHT_EMBEDDED_CHANGELOG;
		delete g.__EIGHT_EMBEDDED_CHANGELOG;
		try {
			expect(readBundledChangelog("/nonexistent-dir-xyz")).toBeNull();
		} finally {
			if (prev !== undefined) g.__EIGHT_EMBEDDED_CHANGELOG = prev;
		}
	});
	test("the package install reads the CHANGELOG.md file", () => {
		const prev = g.__EIGHT_EMBEDDED_CHANGELOG;
		delete g.__EIGHT_EMBEDDED_CHANGELOG;
		try {
			expect(readBundledChangelog()).toContain("## [");
		} finally {
			if (prev !== undefined) g.__EIGHT_EMBEDDED_CHANGELOG = prev;
		}
	});
});
