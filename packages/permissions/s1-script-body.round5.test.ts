/**
 * Round 5 of the script-body check: a body counts as checked only when every simple command in
 * it has a shape this check reads whole. Anything else makes the whole body unchecked (ask;
 * headless: block). Static: scriptLaunch only reads files, nothing runs.
 *
 * The first three cases are the 8SO fourth read on f88e743c (function heads without spaces, a
 * nameref declared with no value). The rest are the constructs the allowlist refuses in a body.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-round5-");
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
	writeFileSync(join(dir, "evil.sh"), "echo MARK_HIGH\n");
});
const kind = (cmd: string) => scriptLaunch(cmd, dir, dir).kind;
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return kind("bash run.sh");
};
const SPAWN = `python3 -c 'import subprocess; subprocess.run(["bash", "ok.sh"])'\n`;

describe("8SO fourth read: function heads and value-less namerefs", () => {
	for (const line of [
		"f(){ export BASH_ENV=./evil.sh; }; f",
		"f ( ) { export BASH_ENV=./evil.sh; }; f",
		"declare -n r; r=BASH_ENV; r=./evil.sh; export r",
	]) {
		test(line, () => expect(bodyKind(`${line}\n${SPAWN}`)).toBe("unchecked"));
	}
});

describe("a body with a shape this check does not read whole is unchecked", () => {
	for (const line of [
		// Function definitions, every spelling.
		"f(){ echo hi; }; f",
		"f ( ) { echo hi; }; f",
		"f () { echo hi; }; f",
		"f()\n{\n  echo hi\n}\nf",
		"function f { echo hi; }; f",
		"function f() { echo hi; }; f",
		"if true; then g(){ echo hi; }; fi",
		// Namerefs, anywhere.
		"declare -n r",
		"declare -gn r",
		"typeset -n r=x",
		"local -n r",
		"command declare -n r",
		// allexport and keyword mode.
		"set -a",
		"set -ea",
		"set -o allexport",
		"set -euo allexport",
		"set -k",
		'set "$opts"',
		// eval, source, alias, trap.
		"eval echo hi",
		"command eval echo hi",
		"builtin eval echo hi",
		"alias ll='ls -l'",
		'trap "$cmd" EXIT',
		'trap "echo $x" EXIT',
		"trap 'eval x' EXIT",
		"trap -- 'f(){ :; }; f' INT",
		"builtin trap 'source ./ok.sh' EXIT",
		"source ./ok.sh",
		". ./ok.sh",
		// Process substitution, backticks, substitutions and expansions as a command name.
		"diff <(ls a) <(ls b)",
		"tee >(cat) < notes.txt",
		"`echo ls` -la",
		'echo "built `date`"',
		"$(echo ls) -la",
		'"$CMD" x',
		"$CMD x",
		'exec "$@"',
		"nohup $X arg",
		"$'ls' x",
		"\\ls",
		"coproc cat",
		// Words the reader cannot classify.
		"echo 'abc",
		'echo "abc',
		"[[ $x =~ ^(a|b)$ ]] && echo y",
	]) {
		test(JSON.stringify(line), () => expect(bodyKind(`${line}\necho done\n`)).toBe("unchecked"));
	}
});

describe("ordinary scripts stay checked", () => {
	test("a typical body", () => {
		expect(
			bodyKind(
				[
					"#!/usr/bin/env bash",
					"set -euo pipefail",
					"set -x",
					"set +e",
					"set -- a b",
					'here="$(cd src && pwd)"',
					"arr=(one two)",
					'echo "${arr[0]}" "$here"',
					"if [ -f notes.txt ]; then cat notes.txt; elif [[ -d src ]]; then ls src; else echo none; fi",
					'case "$1" in',
					"  build) echo build ;;",
					"  *) echo other ;;",
					"esac",
					'for f in *.md; do wc -l "$f"; done',
					"i=0",
					"while (( i < 3 )); do ((i++)); done",
					"(cd src && ls)",
					"{ echo a; echo b; } > out.txt",
					"declare -a list=(x y)",
					"local_var=$((1 + 2))",
					"! grep -q x notes.txt || echo found",
					"time ls",
					"command -v git >/dev/null",
					"export PATH=$HOME/bin:$PATH",
					`trap 'rm -f "$LOCK"' EXIT`,
					"trap - INT",
					"cat <<EOF",
					"function f() { eval x; }",
					"EOF",
					"find . \\( -name '*.ts' -o -name '*.js' \\) -print",
					"",
				].join("\n"),
			),
		).toBe("checked");
	});
});

describe("command lines keep their round 4 behaviour", () => {
	for (const cmd of ["PS4=x ls", "export FOO=$(pwd)", 'echo "$BASH_ENV"']) {
		test(`${cmd} is none`, () => expect(kind(cmd)).toBe("none"));
	}
});

describe("quiet programs: rg and PATH", () => {
	for (const cmd of [
		"BASH_ENV=./evil.sh rg --pre ./pre.sh x .",
		"BASH_ENV=./evil.sh rg x .",
		"PATH=.:$PATH BASH_ENV=./evil.sh ls",
		"export PATH=.:$PATH; export BASH_ENV=./evil.sh; ls",
	]) {
		test(`${cmd} is unchecked`, () => expect(kind(cmd)).toBe("unchecked"));
	}
	test("a quiet line without a PATH change stays none", () => {
		expect(kind("BASH_ENV=./evil.sh ls")).toBe("none");
	});
});
