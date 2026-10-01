/**
 * #3303: the parser must see the argv sh runs.
 *
 * shellWords (rules.ts) started a comment at a `#` anywhere in a word. POSIX
 * sh, which runs the gate's commands (packages/core/shell.ts, `sh -c`), only
 * starts one at the beginning of a word. Everything after a mid-word `#` was
 * invisible to the rules and the allowlist, but sh still ran it.
 *
 * The parity test feeds each corpus line to `sh -c` in an empty directory and
 * compares the argv sh produces with shellWords. The empty directory keeps an
 * unmatched glob literal in sh, as it is in shellWords. Brace expansion is not
 * in the corpus: it is a bash extension the parser does not model, so the
 * allowlist refuses it instead (no-opinion, the judge decides).
 *
 * Commands are parser text only, except the corpus, which sh only splits into
 * words for `printf`: no line in it runs a program.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyAllowlist } from "./allowlist";
import { decideRules, shellWords } from "./rules";

const passes = (c: string) => readOnlyAllowlist(c).verdict === "pass-without-model";

/** Each line is only ever handed to sh as words for printf. No `;|&$()<>`, backtick or bare newline outside quotes. */
const CORPUS: string[] = [
	"a#b c",
	"a #b c",
	"#x y",
	"a b#",
	"'a'#b",
	'"a"#b c',
	'""#x',
	"a\\#b",
	"a\\\\#b",
	"x=1#y",
	"--name=a#b --flag",
	"-name a#b -delete",
	"log a#b --output=out.txt",
	"a\tb#c",
	'"a b"#c d',
	'a"#"b',
	"a\\\nb",
	'"a\\\nb"',
	'"a\\$b"',
	'"a\\\\b"',
	'"a\\qb"',
	'"\\`"',
	"'a\\b'",
	"a\\ b",
	"\"x\"'y'z",
	"''",
	"*.nomatch-3303",
	"x # tail",
	"two#three # four",
];
// A bare newline is not here: it ends the command in sh, and splitSegments
// cuts segments on it before shellWords sees them. Backslash-newline is.

/** The argv sh builds for `line`, as printf arguments. */
function shArgv(line: string, cwd: string): string[] {
	const script = `set -- ${line}\nfor a do printf '%s\\0' "$a"; done`;
	const r = spawnSync("sh", ["-c", script], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`sh failed on ${JSON.stringify(line)}: ${r.stderr}`);
	return r.stdout === "" ? [] : r.stdout.slice(0, -1).split("\0");
}

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

describe.skipIf(!hasSh)("shellWords matches sh -c (#3303)", () => {
	const dir = mkdtempSync(join(tmpdir(), "s1-parity-"));
	for (const line of CORPUS) {
		test(JSON.stringify(line), () => {
			expect({ line, words: shellWords(line) }).toEqual({ line, words: shArgv(line, dir) });
		});
	}
	test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});

describe("shellWords: comments start only at the beginning of a word (#3303)", () => {
	test("mid-word # is an ordinary character; word-start # is a comment", () => {
		expect(shellWords("find . -name a#b -delete")).toEqual([
			"find",
			".",
			"-name",
			"a#b",
			"-delete",
		]);
		expect(shellWords("echo a #b c")).toEqual(["echo", "a"]);
		expect(shellWords("a\\ b c # tail")).toEqual(["a b", "c"]);
	});
});

describe("the #3303 bypasses are judged, not passed", () => {
	test("find with a mid-word # before -delete: rule fires, allowlist refuses", () => {
		const c = "find . -name a#b -delete";
		expect(decideRules(c).rules).toContain("find_delete");
		expect(passes(c)).toBe(false);
	});

	test("git log with a mid-word # before an output-file flag: allowlist refuses", () => {
		expect(passes("git log a#b --output=out.txt")).toBe(false);
		expect(passes("git log --oneline a#b -o out.txt")).toBe(false);
	});

	test("a mid-word # alone still passes a read-only command", () => {
		expect(passes("ls a#b")).toBe(true);
		expect(passes("grep -n 'x' notes#1.md")).toBe(true);
	});
});

describe("allowlist: no-opinion on unquoted globs and brace expansion (#3303)", () => {
	test("unquoted globs and braces go to the judge", () => {
		for (const c of [
			"ls *",
			"cat src/*.ts",
			"ls file?.txt",
			"ls [ab].txt",
			"rg foo *",
			"find . -name *.ts",
			"cat {a,b}.txt",
			"ls x{1..3}",
			'cat {"a",b}',
			"ls a && cat *",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("quoted or escaped glob characters, braces without expansion, and $? still pass", () => {
		for (const c of [
			"grep -n '*' notes.md",
			'grep -rn "foo?" src',
			"find . -name '*.ts'",
			"echo \\*",
			"echo $?",
			"echo '{a,b}'",
			"echo {}",
			"ls",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});
});

// `>&2` duplicates an fd only when the digits end the word. `>&2foo` is a
// redirect to the FILE `2foo` (#3299 re-review). Both parsers read `&2` and
// left `foo` behind as an argument, so the write was invisible.
describe("redirect: >&<digits> is an fd only at a word boundary (#3303)", () => {
	const WRITES = ["ls >&2foo", "ls 2>&1foo", "echo x >&2-out.txt"];

	test("the allowlist refuses a >& redirect that names a file", () => {
		for (const c of WRITES) expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("an fd duplication still passes", () => {
		for (const c of ["ls >&2", "ls 2>&1", "ls 2>&1 | head", "ls >&2 2>/dev/null"])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});

	test("the rules now see the file behind >&", () => {
		expect(decideRules("echo x >&.zshrc").rules).toContain("truncate_sensitive_file");
		expect(decideRules("echo x 2>&1").verdict).toBe("pass");
	});

	test.skipIf(!hasSh)("sh really writes the file (so the parsers must see it)", () => {
		const dir = mkdtempSync(join(tmpdir(), "s1-redir-"));
		try {
			for (const [c, file] of [
				// bash-as-sh calls `2>&1foo` an ambiguous redirect; zsh writes `1foo`.
				["ls >&2foo", "2foo"],
				["echo x >&2-out.txt", "2-out.txt"],
			] as const) {
				spawnSync("sh", ["-c", c], { cwd: dir });
				expect({ c, written: existsSync(join(dir, file)) }).toEqual({ c, written: true });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// maskQuotes and splitSegments do not model comments: the apostrophe in
// `# it's` opens a phantom quote that runs to the `'` in a trailing comment,
// so line 2 vanished from the rules and the allowlist while sh ran it (#3303
// review). The allowlist now refuses any comment, newline or CR.
describe("comment desync: a quote inside a comment hides the next line (#3303)", () => {
	const PROBES = [
		"ls # it's\nfind . -delete #'",
		"ls # it's\ncat * #'",
		"ls # it's\ngit log --output=out.txt #'",
		"ls # it's\nsort -o out.txt in.txt #'",
	];

	test("each probe is no-opinion", () => {
		for (const c of PROBES) expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("comments, newlines and CRs are no-opinion; a mid-word # is not a comment", () => {
		for (const c of ["ls # note", "ls;#x", "ls a\nls b", "ls a\rb", "ls\r", "echo 'a #b'"])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
		for (const c of ["ls a#b", "echo $?", "ls -la"])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});

	test("shellWords refuses a CR instead of splitting on it (sh keeps it in the word)", () => {
		expect(shellWords("ls a\rb")).toBeNull();
		expect(shellWords("git rm --cached\r a")).toBeNull();
	});

	test.skipIf(!hasSh)("sh really runs the line after the comment", () => {
		const r = spawnSync("sh", ["-c", "true # it's\necho RAN-3303 #'"], { encoding: "utf8" });
		expect(r.stdout).toContain("RAN-3303");
		expect(passes("true # it's\necho RAN-3303 #'")).toBe(false);
	});
});
