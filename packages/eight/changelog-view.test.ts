import { describe, expect, test } from "bun:test";
import { sanitizeForDisplay, formatSections, latestSections, loadChangelog, parseChangelog, sectionsSince } from "./changelog-view.js";

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
