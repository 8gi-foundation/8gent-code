/**
 * #3306: four older write paths the read-only allowlist passed without the judge.
 *
 *   1. a redirect target under /tmp/ containing `..` (an arbitrary file write);
 *   2. sort with an attached `-o<file>` or an abbreviated `--output`;
 *   3. `file -C -m <name>`, which compiles <name>.mgc;
 *   4. attached-flag forms for tree (`-o<file>`) and date (`-s<value>`).
 *
 * Each is no-opinion now. The real-shell suite runs a corpus under `sh -c` in
 * a throwaway directory and asserts that whatever the allowlist passes writes
 * no file, there or outside it. date is classified only, never run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyAllowlist } from "./allowlist";

const passes = (c: string) => readOnlyAllowlist(c).verdict === "pass-without-model";

describe("redirect targets (#3306)", () => {
	test("a target that leaves /tmp is refused, however it is spelled", () => {
		for (const c of [
			"echo x > /tmp/../Users/someone/.zshrc",
			"echo x >> /tmp/../etc/hosts",
			"echo x > /private/tmp/../../etc/hosts",
			"echo x > /tmp/a/../../x",
			"echo x > /tmp/.\\./x", // sh: `.\.` is `..`
			"echo x > /tmp/.'.'/x",
			'echo x > "/tmp/.."/x',
			"echo x > /tmp/",
			"echo x > /tmp",
			"echo x > /tmpfoo/x",
			"ls 2> /tmp/../x",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("a plain temp file, /dev/null and fd duplication still pass", () => {
		for (const c of [
			"echo x > /tmp/out.txt",
			"ls >> /private/tmp/run/log.txt",
			"ls 2>/dev/null",
			"ls 2>&1",
			'ls > "/tmp/a b.txt"',
			"ls > /tmp/./out.txt",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});
});

describe("writing flags, attached and abbreviated (#3306)", () => {
	test("each form is refused", () => {
		for (const c of [
			"sort -oout.txt in.txt",
			"sort -o out.txt in.txt",
			"sort -ro out.txt in.txt",
			"sort -rout.txt in.txt",
			"sort --output=out.txt in.txt",
			"sort --outp=out.txt in.txt",
			"sort --o out.txt in.txt",
			"file -C -m magic",
			"file -Cm magic",
			"file --compile -m magic",
			"file --comp -m magic",
			"tree -oout.txt",
			"tree -o out.txt",
			"tree -ao out.txt",
			"tree -R -H . -o x",
			"tree -R",
			"date -s 2026-01-01",
			"date -s2026-01-01",
			"date -us 2026-01-01",
			"date --set=2026-01-01",
			"date --se 2026-01-01",
			"rg --pre=cat x",
			"rg --pre-glob '*.gz' x",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("ordinary read-only forms still pass", () => {
		for (const c of [
			"sort in.txt",
			"sort -r -k2 -t, in.txt",
			"sort -u in.txt",
			"file in.txt",
			"file -b in.txt",
			"tree -L 2",
			"tree -a",
			"date",
			"date -u",
			"date +%Y",
			"rg --pretty x",
			"find . -name x -print",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});
});

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

describe.skipIf(!hasSh)("real shell: whatever the allowlist passes writes nothing", () => {
	// A directory outside /tmp, so `/tmp/..` + its path lands back inside it.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "s1-writes-")));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const SEED = ["in.txt", "magic"];
	const seed = () => {
		for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
		writeFileSync(join(dir, "in.txt"), "b\na\n");
		writeFileSync(join(dir, "magic"), "0\tstring\tS1TEST\ts1 test file\n");
	};
	// /tmp is /private/tmp on macOS, so /tmp/.. is /private: strip that prefix.
	const outside = `/tmp/..${dir.replace(/^\/private(?=\/)/, "")}/escaped.txt`;
	const corpus = [
		`echo x > ${outside}`,
		"sort -oout.txt in.txt",
		"sort --outp=out2.txt in.txt",
		"file -C -m magic",
		"sort in.txt",
		"file in.txt",
		"ls",
	];
	for (const c of corpus) {
		test(c, () => {
			seed();
			const passed = passes(c);
			spawnSync("sh", ["-c", c], { cwd: dir, encoding: "utf8" });
			const created = readdirSync(dir).filter((f) => !SEED.includes(f));
			if (passed) expect({ c, created }).toEqual({ c, created: [] });
			// The four bypasses must not pass, and the reason is real: they write.
			if (!["sort in.txt", "file in.txt", "ls"].includes(c))
				expect({ c, passed }).toEqual({ c, passed: false });
		});
	}

	test("the /tmp/.. target really escapes /tmp (so refusing it matters)", () => {
		seed();
		spawnSync("sh", ["-c", `echo x > ${outside}`], { cwd: dir });
		expect(existsSync(join(dir, "escaped.txt"))).toBe(true);
	});
});
