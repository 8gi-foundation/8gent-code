/**
 * Replay of every attack body from 8SO reads 1-8 and 8GO's second read on 8gent-code#4247, in one
 * file, so a regression in any earlier shape fails here. The bodies are the ones the per-round
 * test files hold, gathered; those files keep their own grouping and comments. Static:
 * scriptLaunch only reads files, nothing runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);
let dir = "";
beforeAll(() => {
	dir = tempDir("s1-replay-");
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
	writeFileSync(join(dir, "evil.sh"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "evil.sh"), 0o755);
	writeFileSync(join(dir, "d.txt"), "a[$(bash evil.sh)]");
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "tool"), "#!/bin/bash\necho MARK_HIGH >&2\n");
	chmodSync(join(dir, "bin", "tool"), 0o755);
});
const kind = (cmd: string) => scriptLaunch(cmd, dir, dir).kind;
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return kind("bash run.sh");
};
const SPAWN = `python3 -c 'import subprocess; subprocess.run(["bash", "ok.sh"])'\n`;
const ARITH = "x='a[$(c=bash; $c evil.sh)]'\n";
const FILE = "x=$(cat d.txt)\n";

const R4_QUOTE: string[] = [
	'export "BASH"_ENV=./evil.sh',
	'export BASH_E""NV=./evil.sh',
	"export B\\ASH_ENV=./evil.sh",
	"v=BASH; export ${v}_ENV=./evil.sh",
	"export $(echo QkFTSF9FTlY9Li9ldmlsLnNo | base64 -d)",
];
const R5_HEADS: string[] = [
	"f(){ export BASH_ENV=./evil.sh; }; f",
	"f ( ) { export BASH_ENV=./evil.sh; }; f",
	"declare -n r; r=BASH_ENV; r=./evil.sh; export r",
];
const R4_ASSIGN: string[] = [
	"BASH_ENV=./evil.sh python3 x.py",
	"declare -x 'BASH_ENV'=./evil.sh",
	"typeset -x ZDOTDIR=.",
	"readonly SHELLOPTS",
	"local PS4=x",
	'env "BASH"_ENV=./evil.sh python3 x.py',
	"nice -n 5 env BASH_ENV=./evil.sh python3 x.py",
	"sudo BASH_ENV=./evil.sh python3 x.py",
	"command export BASH_ENV=./evil.sh",
	": ${BASH_ENV:=./evil.sh}",
	": ${BASH_ENV=./evil.sh}",
	"read BASH_ENV < path.txt",
	"read -r -p 'path: ' BASH_ENV",
	"printf -v BASH_ENV %s ./evil.sh",
	"printf -vBASH_ENV %s ./evil.sh",
	"mapfile -t BASH_ENV < list.txt",
	"getopts ab: BASH_ENV",
	"for BASH_ENV in ./evil.sh; do python3 x.py; done",
	"declare -n r=BASH_ENV; r=./evil.sh",
	"eval 'export BASH_ENV=./evil.sh'",
	"eval export BASH_E''NV=./evil.sh",
	"sh -c 'export BASH_ENV=./evil.sh; python3 x.py'",
	"trap 'export BASH_ENV=./evil.sh' EXIT",
	"let BASH_ENV=1",
	"(( BASH_ENV = 1 ))",
	"x=$(( BASH_ENV = 1 ))",
	"(export BASH_ENV=./evil.sh; python3 x.py)",
	"f() { export BASH_ENV=./evil.sh; }",
	"case $1 in a) export BASH_ENV=./evil.sh;; esac",
	"echo BASH_ENV=./evil.sh python3 x.py | xargs env",
	"xargs -I{} env {} python3 x.py < list.txt",
];
const R4_NAME: string[] = [
	'export "$x"',
	'declare -x "$@"',
	"export $NAME=1",
	"export `cat name`=1",
	"export {BASH,X}_ENV=1",
	"export BASH_EN?=1",
	"env $PAIR python3 x.py",
	'printf -v "$name" %s 1',
	"read $name",
	"a[BASH_ENV=1]=x",
];
const R4_TEXT: string[] = [
	"bash -c 'export \"$x\"; python3 x.py'",
	"sh -lc 'export $(cat pairs); python3 x.py'",
	"trap 'export $(cat pairs)' EXIT",
	"ssh host 'export BASH_ENV=./evil.sh; python3 x.py'",
	"printf '%s\\n' 'export BASH_ENV=./evil.sh' > ~/.profile",
];
const R4_CHAIN: string[] = [
	"sudo env BASH_ENV=./evil.sh python3 x.py",
	"sudo -u root env -i ZDOTDIR=. python3 x.py",
	"timeout 5 sudo BASH_ENV=./evil.sh python3 x.py",
];
const R5_REFUSED: string[] = [
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
];
const R4_CMDLINE: string[] = [
	'export "BASH"_ENV=evil.sh; bash ok.sh',
	"export B\\ASH_ENV=evil.sh; bash ok.sh",
	"env BASH_E''NV=evil.sh bash ok.sh",
	'declare -x "$@"; bash ok.sh',
	'export "BASH"_ENV=evil.sh; bash -c true',
	"BASH_ENV=evil.sh python3 x.py",
];
const SR_NONE: string[] = [
	"BASH_ENV=evil.sh bash -c true",
	"BASH_ENV=evil.sh bash ok.sh",
	"env BASH_ENV=evil.sh bash -c true",
	"export BASH_ENV=evil.sh; bash -c true",
	"ZDOTDIR=. zsh -c true",
];
const SR_TEXT: string[] = [
	"trap 'bash evil.sh' EXIT",
	"flock /tmp/l -c 'bash evil.sh'",
	"script -q /dev/null -c 'bash evil.sh'",
];
const SR_CTRL: string[] = [
	"(bash evil.sh)",
	"( bash evil.sh )",
	"{ bash evil.sh; }",
	"if true; then bash evil.sh; fi",
	"for i in 1; do bash evil.sh; done",
	"f() { bash evil.sh; }; f",
	"echo $(bash evil.sh)",
	"bash evil.sh &",
	"ba''sh evil.sh",
	"\\bash evil.sh",
	"time -p bash evil.sh",
	"nohup sh -c 'bash evil.sh'",
	"sudo -E bash evil.sh",
	"env -S 'bash evil.sh'",
	"setsid bash evil.sh",
	"echo evil.sh | xargs bash",
	"bash < evil.sh",
	"cat evil.sh | sh",
	"bash <(cat evil.sh)",
	'eval "$(cat evil.sh)"',
	'bash -c "$(cat evil.sh)"',
	"$SHELL evil.sh",
	"exec -a x bash evil.sh",
];
const R5F: [string, string][] = [
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
const R58: [string, string][] = [
	[
		"MF1 here-doc to a shell, function head",
		`bash <<'EOF'\nf(){ export BASH_ENV=./evil.sh; }; f\n${SPAWN}EOF\n`,
	],
	["MF1 here-doc substitution, function", "cat <<EOF\n$(f(){ bash evil.sh; }; f)\nEOF\n"],
	["MF2 $((x))", `${ARITH}echo $((x))\n`],
	["MF2 (( x ))", `${ARITH}(( x ))\n`],
	["MF2 ${arr[x]}", `${ARITH}echo "\${arr[x]}"\n`],
	["MF2 declare -i", `declare -i v\n${ARITH}v=x\n`],
	["MF2 ${x@P} (bash 4.4+)", "x='$(c=bash; $c evil.sh)'\necho \"${x@P}\"\n"],
	["MF3 hash -p", "hash -p ./evil.sh ls\nls\n"],
	["MF4 PATH=", "PATH=./bin:$PATH\ntool\n"],
	["MF4 export PATH=", 'export PATH="$PWD/bin:$PATH"\ntool\n'],
	["MF5 exec <file; bash", "exec 0<evil.sh\nbash\n"],
	["MF5 exec <file; bash -s", "exec <evil.sh\nbash -s\n"],
	["MF5 exec <file; sh", "exec <evil.sh\nsh\n"],
] as [string, string][];

const R6: [string, string][] = [
	["R6 name", "read y < d.txt\nx=$((0))$y$((0))\necho $(( x ))\n"],
	["R6 arg", "x=$((0))$1$((0))\n(( x ))\n"],
	["R6 env", "x=$((0))$HOME$((0))\n(( x ))\n"],
	["R6 sub", "x=$((0))$(cat d.txt; echo $((0)))\n(( x ))\n"],
	["R6 quoted sub", 'x="$((0))$(cat d.txt)$((0))"\n(( x ))\n'],
];
const CASE_ARMS = [
	"case x in x) bash evil.sh;; esac",
	"case x in x) ./evil.sh;; esac",
	"case x in 'x') bash evil.sh;; esac",
	"case x in *) bash evil.sh;; esac",
	"if true; then case x in x) bash evil.sh;; esac; fi",
	"while true; do case x in x) bash evil.sh;; esac; done",
	"case x in x) . evil.sh;; esac",
	"case x in x) source evil.sh;; esac",
	"case x in x) BASH_ENV=evil.sh bash -c true;; esac",
	"case x in a|x) bash evil.sh;; esac",
	"case x in x) (./evil.sh);; esac",
];
const SUBSHELLS = [
	"(./evil.sh)",
	"( ./evil.sh )",
	"( ./evil.sh; )",
	"(./evil.sh) && ls",
	"(bash evil.sh)",
	"{ ./evil.sh; }",
	"( (./evil.sh) )",
	"x=1; (./evil.sh)",
	"if (./evil.sh); then echo; fi",
	"! (./evil.sh)",
	"cat evil.sh | (bash)",
	"cat evil.sh | (bash -s)",
	"case x in (x) (./evil.sh);; esac",
	"case x in (x) bash evil.sh;; esac",
	"(evil.sh)",
	"case x in x) true; (./evil.sh);; esac",
	'case "$1" in\n*)\necho go\n(./evil.sh)\n;;\nesac',
	"case x in x) echo a | (bash);; esac",
	"case x in x)\n(./evil.sh)\n;;\nesac",
	"case x in x) echo hi;;\n(y) ./evil.sh;; esac",
	"{ bash; } <<X\n./evil.sh\nX",
	"(bash) <<X\n./evil.sh\nX",
	"case x in x) echo hi # ;;\n(./evil.sh)\n;;\nesac",
	"case x in x) true\n# ;;\n(./evil.sh)\n;;\nesac",
	"case x in x) true\n# ;&\n(./evil.sh)\n;;\nesac",
	"case x in x) true # ;;\n(bash) < evil.sh\n;;\nesac",
	"f() { ./evil.sh; }; f",
	"function f { ./evil.sh; }; f",
	"shopt -s extglob; case x in @(x)) ./evil.sh;; esac",
	"setopt kshglob; case x in @(x)) ./evil.sh;; esac",
	"alias ll=./evil.sh; ll",
];

describe("replay: reads 1-4 command lines and bodies", () => {
	for (const l of R4_QUOTE)
		test(`r4 quote ${l}`, () => expect(bodyKind(`${l}\n${SPAWN}`)).toBe("unchecked"));
	for (const l of R5_HEADS)
		test(`r5 head ${l}`, () => expect(bodyKind(`${l}\n${SPAWN}`)).toBe("unchecked"));
	for (const l of [...R4_ASSIGN, ...R4_NAME, ...R4_TEXT, ...R4_CHAIN])
		test(`r4 body ${l}`, () => expect(bodyKind(`${l}\n`)).toBe("unchecked"));
	for (const l of R5_REFUSED)
		test(`r5 refused ${l}`, () => expect(bodyKind(`${l}\necho done\n`)).toBe("unchecked"));
	for (const c of R4_CMDLINE) test(`r4 line ${c}`, () => expect(kind(c)).toBe("unchecked"));
	for (const c of SR_CTRL) test(`sr control ${c}`, () => expect(kind(c)).not.toBe("none"));
	for (const c of [...SR_NONE, ...SR_TEXT]) test(`sr ${c}`, () => expect(kind(c)).not.toBe("none"));
});

describe("replay: reads 5-6 bodies", () => {
	for (const [n, b] of R5F) test(`r5 fix ${n}`, () => expect(bodyKind(b)).toBe("unchecked"));
	for (const [n, b] of R58) test(`r5 8so ${n}`, () => expect(bodyKind(b)).toBe("unchecked"));
	for (const [n, b] of R6) test(n, () => expect(bodyKind(b)).not.toBe("checked"));
});

describe("replay: 8GO second read and 8SO read 8", () => {
	for (const l of CASE_ARMS) {
		test(`case body ${l}`, () => expect(bodyKind(`${l}\n`)).not.toBe("checked"));
		test(`case line ${l}`, () => expect(kind(l)).not.toBe("none"));
	}
	for (const l of SUBSHELLS) {
		test(`group body ${l}`, () => expect(bodyKind(`${l}\n`)).not.toBe("checked"));
		test(`group line ${l}`, () => expect(kind(l)).not.toBe("none"));
	}
	test("controls: a harmless case is unchecked (cost); a group is not", () => {
		expect(bodyKind("case x in x) echo hello;; esac\n")).toBe("unchecked");
		expect(bodyKind("(cd . && ls)\n{ echo a; echo b; } > out.txt\n")).toBe("checked");
		expect(bodyKind("x=$((1+2))\necho $(( x + 1 ))\n")).toBe("checked");
	});
});

// Every refused body and command line above, moved: after `true;`, before `;true`, inside a
// case arm (one line, several lines, after another command). The invariant: where it sits does
// not change the refusal. Collected into one list per kind so a failure names the shape.
const BODIES: string[] = [
	...R4_QUOTE.map((l) => `${l}\n${SPAWN}`),
	...R5_HEADS.map((l) => `${l}\n${SPAWN}`),
	...[...R4_ASSIGN, ...R4_NAME, ...R4_TEXT, ...R4_CHAIN].map((l) => `${l}\n`),
	...R5_REFUSED.map((l) => `${l}\necho done\n`),
	...R5F.map(([, b]) => b),
	...R58.map(([, b]) => b),
	...R6.map(([, b]) => b),
	...[...CASE_ARMS, ...SUBSHELLS].map((l) => `${l}\n`),
];
const LINES: string[] = [
	...R4_CMDLINE,
	...SR_CTRL,
	...SR_NONE,
	...SR_TEXT,
	...CASE_ARMS,
	...SUBSHELLS,
];
const MOVES: [string, (b: string) => string][] = [
	["true; before", (b) => `true; ${b}`],
	["; true after", (b) => `${b.replace(/\n$/, "")}\ntrue\n`],
	[
		"case arm, one line",
		(b) => (b.includes("\n") ? `case x in x)\n${b}\n;;\nesac\n` : `case x in x) ${b};; esac\n`),
	],
	["case arm, several lines", (b) => `case x in\n x)\n${b.replace(/\n$/, "")}\n ;;\nesac\n`],
	["case arm, after a command", (b) => `case x in x) true; ${b.replace(/\n$/, "")}\n;; esac\n`],
	[
		"case arm, second arm",
		(b) => `case x in y) echo no;;\n x)\n${b.replace(/\n$/, "")}\n;;\nesac\n`,
	],
];

describe("fuzz: moving a refused shape does not change the refusal", () => {
	for (const [move, f] of MOVES) {
		test(`bodies, ${move}`, () => {
			const leaked = BODIES.filter((b) => bodyKind(f(b)) === "checked");
			expect(leaked).toEqual([]);
		});
		test(`command lines, ${move}`, () => {
			const leaked = LINES.filter((l) => kind(f(l)) === "none");
			expect(leaked).toEqual([]);
		});
	}
	test("the fuzz covers a real number of shapes", () => {
		expect(BODIES.length).toBeGreaterThan(150);
		expect(LINES.length).toBeGreaterThan(50);
	});
});

describe("replay: ordinary scripts without case, functions or glob modes stay checked", () => {
	for (const [n, b] of [
		[
			"if and for",
			'if [ -f notes.txt ]; then cat notes.txt; fi\nfor f in *.md; do wc -l "$f"; done\n',
		],
		["subshell and group", "(cd . && ls)\n{ echo a; echo b; } > out.txt\n"],
		["comment mentioning case", "# the case for a test\necho hi\n"],
		["case as an argument", "grep case notes.txt\necho 'case x in'\n"],
		["counter", "n=0\nwhile (( n < 3 )); do n=$((n + 1)); done\n"],
	] as [string, string][])
		test(n, () => expect(bodyKind(b)).toBe("checked"));
	test("comment with a case terminator is refused", () => {
		expect(bodyKind("echo hi # ;;\n")).toBe("unchecked");
	});
});

describe("replay: every case shape is unchecked, body and command line", () => {
	for (const l of CASE_ARMS) {
		test(`body ${l}`, () => expect(bodyKind(`${l}\n`)).toBe("unchecked"));
		test(`line ${l}`, () => expect(kind(l)).toBe("unchecked"));
	}
});
