/**
 * The gate must be able to FAIL.
 *
 * #11/486: the shipped gate reported "No syntax errors" on a repository that
 * contains 27 of them, because its regex matched nothing. The root cause was
 * fixed here and, more importantly, the OUTPUT FORMAT of the parser is now
 * pinned by tests.
 *
 * The failure being guarded against is specific and has already happened twice:
 * a parser that reads the wrong source, or the right source in the wrong shape,
 * and reports success. That is not caught by reading the diff. It is caught by
 * running against known input and demanding the right answer.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { SYNTAX_CODES, parseDiagnostics, repoRootFrom } from "./excluded-parse-check.mjs";

const BUN_FORMAT = [
	'<error file="packages/skills/business-builder/src/types/index.ts" line="101" column="75" code="TS1005">',
	"Expected '>' but found '='.",
	"<source>",
	"101 |   setBlueOceanStrategy(strategy: Parameters<typeof this.blueOceanStrategy = [])[0]) {",
	"</source>",
	"</error>",
	'<error file="packages/tools/markdown-parser.ts" line="339" column="15" code="TS1002">',
	"Unterminated string literal.",
	"<source>",
	"339 |     return '",
	"</source>",
	"</error>",
].join("\n");

const TSC_FORMAT = [
	"packages/skills/business-builder/src/types/index.ts(101,75): error TS1005: '>' expected.",
	"packages/tools/markdown-parser.ts(339,15): error TS1002: Unterminated string literal.",
].join("\n");

describe("parseDiagnostics reads both checker formats", () => {
	it("reads bun check output", () => {
		const got = parseDiagnostics(BUN_FORMAT);
		expect(got).toHaveLength(2);
		// Captures are m[1], m[2], m[3] - path, line, code. Getting this wrong
		// yields an empty list and a green gate, which is the defect.
		expect(got[0]).toEqual({
			file: "packages/skills/business-builder/src/types/index.ts",
			line: 101,
			code: "TS1005",
		});
		expect(got[1]).toEqual({
			file: "packages/tools/markdown-parser.ts",
			line: 339,
			code: "TS1002",
		});
	});

	it("reads tsc output", () => {
		const got = parseDiagnostics(TSC_FORMAT);
		expect(got).toHaveLength(2);
		expect(got[0].code).toBe("TS1005");
		expect(got[1].file).toBe("packages/tools/markdown-parser.ts");
	});

	it("returns nothing for empty input - and that alone must never be a pass", () => {
		expect(parseDiagnostics("")).toEqual([]);
		expect(parseDiagnostics("some unrelated log line")).toEqual([]);
	});

	it("never yields an undefined code, whatever the input", () => {
		for (const text of [
			BUN_FORMAT,
			TSC_FORMAT,
			"",
			"garbage",
			'<error file="a.ts" line="1" code="TS1005">',
		]) {
			for (const d of parseDiagnostics(text)) {
				expect(typeof d.code).toBe("string");
				expect(typeof d.line).toBe("number");
				expect(d.code).toMatch(/^TS\d+$/);
			}
		}
	});
});

describe("the syntax filter is narrow on purpose", () => {
	it("keeps the three real parse errors", () => {
		const codes = parseDiagnostics(BUN_FORMAT).map((d) => d.code);
		for (const d of parseDiagnostics(BUN_FORMAT)) {
			expect(SYNTAX_CODES.has(d.code)).toBe(true);
		}
		expect(codes).toContain("TS1005");
		expect(codes).toContain("TS1002");
	});

	it("excludes type errors, which are tolerated in excluded paths", () => {
		// TS2307 cannot find module, TS2320 interface conflict: real errors, but
		// not parse errors, and not this gate's business.
		const typeish = '<error file="a.ts" line="1" column="1" code="TS2307">x</error>';
		const got = parseDiagnostics(typeish);
		expect(got).toHaveLength(1);
		expect(SYNTAX_CODES.has(got[0].code)).toBe(false);
	});
});

describe("repoRootFrom does not depend on cwd", () => {
	it("resolves the repo root from the script location alone", () => {
		const root = repoRootFrom(new URL("../scripts/excluded-parse-check.mjs", import.meta.url));
		// 🔴 Do NOT assert on the worktree directory NAME.
		//
		// `expect(root).toContain("sopwt")` passed only because this happened to be
		// checked out as /home/artale/sopwt. It reported the machine, not the
		// property, and it was the one assertion in this file that could not
		// survive a clone anywhere else. The property is: absolute, not
		// drive-doubled, and containing the tsconfig the gate actually reads.
		expect(isAbsolute(root)).toBe(true);
		expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
		// The C:/c/ doubling is the failure this guards against.
		expect(root).not.toContain("C:\\c");
		expect(root).not.toContain("/c/c");
	});

	it("resolves the same root whatever cwd the caller is in", () => {
		const a = repoRootFrom(new URL("../scripts/excluded-parse-check.mjs", import.meta.url));
		const cwd = process.cwd();
		try {
			process.chdir(tmpdir());
			const b = repoRootFrom(new URL("../scripts/excluded-parse-check.mjs", import.meta.url));
			expect(b).toBe(a);
		} finally {
			process.chdir(cwd);
		}
	});
});
