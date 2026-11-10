import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	changelogOutput,
	listChangelogHeadings,
	readChangelogSection,
} from "./changelog-reader.js";

const FILE = [
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

describe("changelog reader", () => {
	test("section for an exact version, heading line first", () => {
		expect(readChangelogSection(FILE, "0.20.45")).toBe(
			"## [0.20.45] - 2026-11-10\n\n### Fixed\n- the forty-five fix",
		);
	});

	test("a leading v is the same version", () => {
		expect(readChangelogSection(FILE, "v0.20.45")).toBe(readChangelogSection(FILE, "0.20.45"));
		expect(changelogOutput(FILE, "v0.20.45", "0.0.0")).toBe(changelogOutput(FILE, "0.20.45", "0.0.0"));
	});

	test("no argument uses the installed version", () => {
		expect(changelogOutput(FILE, undefined, "0.20.3")).toBe("## [0.20.3] - 2026-09-30\n- the three entry");
	});

	test("a version not in the file is one plain line, with no fallback", () => {
		expect(changelogOutput(FILE, "0.20.46", "0.20.45")).toBe("No changelog entry for v0.20.46.");
		expect(changelogOutput(FILE, undefined, "9.9.9")).toBe("No changelog entry for v9.9.9.");
	});

	test("a missing file is one plain line", () => {
		expect(changelogOutput(null, undefined, "0.20.45")).toBe("No changelog file found.");
		expect(changelogOutput(null, "all", "0.20.45")).toBe("No changelog file found.");
	});

	test("all lists the version headings in file order, not Unreleased", () => {
		expect(changelogOutput(FILE, "all", "0.20.45")).toBe(
			["## [0.20.45] - 2026-11-10", "## [0.20.4] - 2026-10-01", "## [0.20.3] - 2026-09-30"].join("\n"),
		);
		expect(listChangelogHeadings(FILE)).toHaveLength(3);
	});

	test("a prefix version does not match the longer one, either way round", () => {
		const four = readChangelogSection(FILE, "0.20.4");
		expect(four).toContain("the four entry");
		expect(four).not.toContain("forty-five");
		expect(readChangelogSection("## [0.20.45] - x\n- a\n", "0.20.4")).toBeNull();
	});

	test("trailing separator is not part of the section", () => {
		expect(readChangelogSection(FILE, "0.20.4")?.endsWith("- the four entry")).toBeTrue();
	});
});

describe("CHANGELOG.md ships in the package", () => {
	test("npm pack --dry-run lists CHANGELOG.md", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
		const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(r.status).toBe(0);
		const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
		expect(files).toContain("CHANGELOG.md");
	});
});
