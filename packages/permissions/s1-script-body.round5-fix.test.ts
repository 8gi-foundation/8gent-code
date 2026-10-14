/**
 * Round 5 fix on 8gent-code#4247 (8SO fifth read): the shapes around each must-fix that the same
 * hole reaches, plus the ordinary bodies that must stay checked. Every "unchecked" body here was
 * run on /bin/bash 3.2 with a harmless payload and ran it (14 Oct 2026), except the two bash 4+
 * shapes marked so.
 *
 * MF2 is wider than the quoted-literal case: a value read from a file, a glob match, an argument
 * or the environment reaches arithmetic the same way, so the gate sits at arithmetic, not at the
 * literal (s1-script-arith.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-r5-fix-");
	writeFileSync(join(dir, "evil.sh"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "evil.sh"), 0o755);
	writeFileSync(join(dir, "d.txt"), "a[$(bash evil.sh)]");
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "tool"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "bin", "tool"), 0o755);
});
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return scriptLaunch("bash run.sh", dir, dir).kind;
};
const FILE = "x=$(cat d.txt)\n";

const UNCHECKED: [string, string][] = [
	// MF1: heredocs
	["unquoted heredoc runs a script in $(...)", "cat <<EOF\n$(bash evil.sh)\nEOF\n"],
	["unquoted heredoc with a backtick", "cat <<EOF\n`bash evil.sh`\nEOF\n"],
	["heredoc fed to bash -s", "bash -s <<'EOF'\nf(){ bash evil.sh; }; f\nEOF\n"],
	[
		"a -c shell fed a heredoc does not cover a stdin shell",
		"bash -c 'echo hi' <<'EOF'\nx\nEOF\nexec <evil.sh\nbash\n",
	],
	// MF2: a value from data in arithmetic
	["file value in $((x))", `${FILE}echo $((x))\n`],
	["file value in $(( $x ))", `${FILE}echo $(( $x ))\n`],
	["read value in arithmetic", "read -r x < d.txt\ny=$((x + 1))\n"],
	["glob match in arithmetic", "for f in *; do echo $((f)); done\n"],
	["script argument in arithmetic", "echo $(( $1 + 1 ))\n"],
	["environment value read before the body sets it", "echo $((x))\nx=0\n"],
	["set only inside a branch", "if false; then x=0; fi\necho $((x))\n"],
	["set only in a subshell", "(x=0)\necho $((x))\n"],
	["set behind &&", "false &&\nx=0\necho $((x))\n"],
	["set first inside a heredoc", "cat <<'EOF'\nx=0\nEOF\necho $((x))\n"],
	["integer then overwritten from a file", `x=0\n${FILE}echo $((x))\n`],
	["[[ -eq ]]", `${FILE}[[ $x -eq 0 ]]\n`],
	["$[x]", `${FILE}echo $[x]\n`],
	["substring offset", `${FILE}s=abc\necho \${s:x}\n`],
	["array literal subscript", `${FILE}arr=([x]=1)\n`],
	["assigned subscript", `${FILE}a[x]=1\n`],
	["let", `${FILE}let y=x\n`],
	["for (( ))", `${FILE}for ((i=x; i<1; i++)); do :; done\n`],
	["${!x}", `${FILE}a=(1)\necho \${!x}\n`],
	["OPTIND then getopts", `${FILE}OPTIND=$x\ngetopts a o\n`],
	["unset a literal subscript", "a=(1)\nunset 'a[$(bash evil.sh)]'\n"],
	["typeset -i", `typeset -i v\n${FILE}v=$x\n`],
	["unquoted heredoc arithmetic", `${FILE}cat <<E\n$((x))\nE\n`],
	["ANSI-C literal in arithmetic", "x=$'a[\\x24(bash evil.sh)]'\necho $((x))\n"],
	["command substitution inside arithmetic", "echo $(( $(cat d.txt) ))\n"],
	["test -v (bash 4+ reads the subscript)", "[[ -v 'a[$(bash evil.sh)]' ]]\n"],
	// MF3
	["hash -rp", "hash -rp ./evil.sh ls\nls\n"],
	// MF4: every way a body sets PATH or the command tables
	["read PATH", "echo ./bin > p\nread PATH < p\ntool\n"],
	["for PATH", "for PATH in ./bin; do tool; done\n"],
	["${PATH:=}", "unset PATH\n: ${PATH:=./bin}\ntool\n"],
	["PATH prefix on one command", "PATH=./bin:$PATH tool\n"],
	["env PATH=", "env PATH=./bin:/usr/bin tool\n"],
	["PATH+=", "PATH+=:./bin\ntool\n"],
	["BASH_CMDS (bash 4+)", "BASH_CMDS[ls]=./evil.sh\nls\n"],
	// MF5
	["bash -", "exec <evil.sh\nbash -\n"],
	["bash fed a redirect in a brace group", "{ bash; } < evil.sh\n"],
	["bash -o errexit with no file", "exec <evil.sh\nbash -o errexit\n"],
];

describe("round 5 fix: shapes the must-fix holes reach", () => {
	for (const [name, body] of UNCHECKED) test(name, () => expect(bodyKind(body)).toBe("unchecked"));
});

describe("round 5 fix: ordinary bodies stay checked", () => {
	for (const [name, body] of [
		["a counter", "n=0\nwhile (( n < 3 )); do n=$((n + 1)); done\necho $n\n"],
		[
			"a counter set on a line with more after it",
			"i=0; while [ $i -lt 2 ]; do i=$((i+1)); done\n",
		],
		["literal arithmetic", "echo $(( 1 + 2 * 3 ))\n"],
		["lengths are not names", 'arr=(a b)\necho "${#arr[@]} ${#1}"\n'],
		["a literal subscript", 'arr=(a b)\necho "${arr[1]}" "${arr[@]}"\n'],
		["a default value", 'name="${1:-world}"\necho "hello ${name}"\n'],
		[
			"awk keeps its own arrays",
			"awk '{ t[$1] += $2 } END { for (k in t) print k, t[k] }' d.txt\n",
		],
		[
			"quoted heredoc written to a file",
			"cat > gen.sh <<'EOF'\nf(){ bash evil.sh; }; echo $((x)) `date`\nEOF\n",
		],
		[
			"unquoted heredoc with a plain substitution",
			"cat > report.txt <<EOF\nBuilt on $(date) by $USER\nEOF\n",
		],
		["heredoc fed to bash", "bash <<'EOF'\necho hi\nEOF\n"],
		["hash as a presence check", "hash git 2>/dev/null || echo 'git missing'\n"],
		["PATH only mentioned", 'command -v jq >/dev/null || echo "jq is not on PATH"\necho "$PATH"\n'],
		["unset a plain name", "x=1\nunset x\n"],
		["declare -a and -r", "declare -a list=(x y)\ndeclare -r ro=1\n"],
	] as [string, string][]) {
		test(name, () => expect(bodyKind(body)).toBe("checked"));
	}
});
