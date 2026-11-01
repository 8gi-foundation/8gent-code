/**
 * 8gent's own scripts resolve from the package, never the working folder
 * (#3264). The TUI now runs in the user's launch folder, so a cloned repo with
 * its own bin/debug.ts or bin/lil-eight.sh must not have those executed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGE_ROOT, packageBinScript } from "./package-scripts.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

describe("packageBinScript (#3264)", () => {
	let planted: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		planted = realpathSync(mkdtempSync(join(tmpdir(), "8gent-untrusted-repo-")));
		mkdirSync(join(planted, "bin"), { recursive: true });
		writeFileSync(join(planted, "bin", "debug.ts"), "throw new Error('planted');\n");
		writeFileSync(join(planted, "bin", "lil-eight.sh"), "echo planted\n");
		process.chdir(planted);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(planted, { recursive: true, force: true });
	});

	test("the package root is this checkout, not the working folder", () => {
		expect(process.cwd()).toBe(planted);
		expect(PACKAGE_ROOT).toBe(REPO_ROOT);
		expect(PACKAGE_ROOT.startsWith(planted)).toBe(false);
	});

	test("bin/debug.ts and bin/lil-eight.sh resolve to the package, not the planted copies", () => {
		for (const name of ["debug.ts", "lil-eight.sh"]) {
			const got = packageBinScript(name);
			expect(got).toBe(join(REPO_ROOT, "bin", name));
			expect(got).not.toBe(join(planted, "bin", name));
		}
	});

	test("a script the package does not ship resolves to null, even if the working folder has it", () => {
		writeFileSync(join(planted, "bin", "only-in-cwd.sh"), "echo planted\n");
		expect(packageBinScript("only-in-cwd.sh")).toBeNull();
	});
});

describe("the TUI never runs bin/ or scripts/ out of the working folder (#3264)", () => {
	test("no process.cwd() lookup of a bin/ or scripts/ path in app.tsx", () => {
		const source = readFileSync(join(import.meta.dir, "..", "app.tsx"), "utf-8");
		const offenders = source
			.split("\n")
			.map((line, i) => ({ line: line.trim(), n: i + 1 }))
			.filter(({ line }) => /process\.cwd\(\)/.test(line) && /["'`/](bin|scripts)\b/.test(line));
		expect(offenders).toEqual([]);
	});
});
