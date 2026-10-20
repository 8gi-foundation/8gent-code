/**
 * Guard for 8gent-code#4567: nobody installing 8gent-code needs Python or
 * Swift for the normal path, and a .py or .swift file must not creep into the
 * installed package unnoticed.
 *
 * It asks npm itself which files the tarball would contain
 * (`npm pack --dry-run --json`), so the `files` field, ignore files and npm's
 * implicit includes are all honoured without reimplementing glob logic. If npm
 * cannot be run it falls back to the declared `files` entries.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Extensions that would put a Python or Swift requirement in the package. */
const FORBIDDEN = /\.(py|pyi|pyw|swift)$/i;

/**
 * Deliberate inclusions. Empty on purpose: add `{ path, reason }` here only
 * when a Python or Swift file truly must ship, so the choice shows in a diff.
 */
const EXCEPTIONS: ReadonlyArray<{ path: string; reason: string }> = [];

function findOffenders(
	paths: readonly string[],
	exceptions: ReadonlyArray<{ path: string }> = EXCEPTIONS,
): string[] {
	const allowed = new Set(exceptions.map((e) => e.path));
	return paths.filter((p) => FORBIDDEN.test(p) && !allowed.has(p)).sort();
}

function failureMessage(offenders: readonly string[]): string {
	return [
		"Python or Swift files would be in the installed 8gent-code package (decision on #4567):",
		...offenders.map((o) => `  - ${o}`),
		"A person installing 8gent-code must not need Python or Swift. Either move the file out",
		'of the packed surface (drop it from package.json "files", or move it outside the paths',
		"that `files` lists), or add it to EXCEPTIONS in this test with a reason.",
	].join("\n");
}

function packedPaths(): { paths: string[]; source: string } {
	const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
	});
	if (r.status === 0) {
		try {
			const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
			const files = parsed[0]?.files;
			if (Array.isArray(files) && files.length > 0) {
				return { paths: files.map((f) => f.path), source: "npm pack --dry-run" };
			}
		} catch {}
	}
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files?: string[] };
	return { paths: pkg.files ?? [], source: "package.json files (npm unavailable)" };
}

describe("installed package has no Python or Swift (#4567)", () => {
	test("no .py or .swift file is in the packed surface", () => {
		const { paths, source } = packedPaths();
		expect(paths.length, `${source} returned nothing`).toBeGreaterThan(0);
		const offenders = findOffenders(paths);
		expect(offenders, failureMessage(offenders)).toEqual([]);
	});

	test("the check itself names offenders and honours the exception list", () => {
		const sample = ["bin/8gent-run.js", "x/a.py", "y/B.SWIFT", "README.md"];
		expect(findOffenders(sample, [])).toEqual(["x/a.py", "y/B.SWIFT"]);
		expect(findOffenders(sample, [{ path: "x/a.py" }])).toEqual(["y/B.SWIFT"]);
		expect(failureMessage(["x/a.py"])).toContain("move the file out");
	});

	test("every exception carries a reason", () => {
		for (const e of EXCEPTIONS) expect(e.reason.trim().length).toBeGreaterThan(0);
	});
});
