/**
 * Round 4 of the script-body check: shell startup variables are read from parsed, dequoted
 * words in assignment positions, not from raw text. Static: scriptLaunch only reads files,
 * nothing runs.
 *
 *   - Quote removal and expansion must not hide a startup variable a body or a command sets.
 *   - A name in an assignment position that is not plain text fails closed.
 *   - Plain mentions (a pattern, a file name, a message, a read) do not ask.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);

let dir = "";
beforeAll(() => {
	dir = tempDir("s1-round4-");
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
	writeFileSync(join(dir, "evil.sh"), "echo MARK_HIGH\n");
});

const kind = (cmd: string) => scriptLaunch(cmd, dir, dir).kind;
/** The verdict for `bash run.sh` when run.sh holds `body`. */
const bodyKind = (body: string) => {
	writeFileSync(join(dir, "run.sh"), body);
	return kind("bash run.sh");
};
/** A program that starts bash itself, so no launch is visible in the body. */
const SPAWN = `python3 -c 'import subprocess; subprocess.run(["bash", "ok.sh"])'\n`;

describe("8SO third read: quote removal and expansion in a body", () => {
	for (const line of [
		'export "BASH"_ENV=./evil.sh',
		'export BASH_E""NV=./evil.sh',
		"export B\\ASH_ENV=./evil.sh",
		"v=BASH; export ${v}_ENV=./evil.sh",
		"export $(echo QkFTSF9FTlY9Li9ldmlsLnNo | base64 -d)",
	]) {
		test(line, () => expect(bodyKind(`${line}\n${SPAWN}`)).toBe("unchecked"));
	}
});

describe("assignment positions in a body", () => {
	for (const line of [
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
	]) {
		test(line, () => expect(bodyKind(`${line}\n`)).toBe("unchecked"));
	}
});

describe("a name that is not plain text in an assignment position fails closed", () => {
	for (const line of [
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
	]) {
		test(line, () => expect(bodyKind(`${line}\n`)).toBe("unchecked"));
	}
});

describe("the command line: quote removal and first position", () => {
	for (const cmd of [
		'export "BASH"_ENV=evil.sh; bash ok.sh',
		"export B\\ASH_ENV=evil.sh; bash ok.sh",
		"env BASH_E''NV=evil.sh bash ok.sh",
		'declare -x "$@"; bash ok.sh',
		'export "BASH"_ENV=evil.sh; bash -c true',
		"BASH_ENV=evil.sh python3 x.py",
	]) {
		test(cmd, () => expect(kind(cmd)).toBe("unchecked"));
	}
});

describe("8SO third read: plain mentions do not ask", () => {
	for (const cmd of [
		"grep -r ENV src",
		"cat docs/ENV.md",
		"docker run -e ENV=prod img",
		'git commit -m "fix ENV parse"',
		"echo ${ENV}",
		"PS4=x ls",
		'echo "$BASH_ENV"',
		"export PATH=$HOME/bin:$PATH",
		"export FOO=$(pwd)",
	]) {
		test(cmd, () => expect(kind(cmd)).toBe("none"));
	}

	test("the same mentions inside a body stay checked", () => {
		expect(
			bodyKind(
				[
					"grep -r ENV src",
					"cat docs/ENV.md",
					"docker run -e ENV=prod img",
					'git commit -m "fix ENV parse"',
					"echo ${ENV}",
					'echo "BASH_ENV is $BASH_ENV"',
					'while IFS= read -r l; do echo "$l"; done < notes.txt',
					"",
				].join("\n"),
			),
		).toBe("checked");
	});
});

describe("M2: a shell word handed to a program that does not run it", () => {
	for (const cmd of ["git grep bash src", 'git commit -m "bash fix"', "code -n bash x"]) {
		test(`${cmd} does not ask`, () => expect(kind(cmd)).toBe("none"));
	}
	for (const cmd of [
		"git grep -O bash x",
		"git grep -iObash x",
		"git grep --open-files-in-pager=bash x",
		"git commit -m x bash ok.sh",
		"git -c x=y grep bash src",
		'git log -S bash -- "$(bash evil.sh)"',
	]) {
		test(`${cmd} still asks`, () => expect(kind(cmd)).not.toBe("none"));
	}
});

describe("command text: strict where it is known to run, lenient elsewhere", () => {
	for (const line of [
		"bash -c 'export \"$x\"; python3 x.py'",
		"sh -lc 'export $(cat pairs); python3 x.py'",
		"trap 'export $(cat pairs)' EXIT",
		"ssh host 'export BASH_ENV=./evil.sh; python3 x.py'",
		"printf '%s\\n' 'export BASH_ENV=./evil.sh' > ~/.profile",
	]) {
		test(`${line} is unchecked`, () => expect(bodyKind(`${line}\n`)).toBe("unchecked"));
	}
	const JS = `node -e 'function L(h){h=h.replace("#","");return h}console.log(L("1a"))'`;
	test("a quoted program that is not shell text does not ask", () => {
		expect(kind(JS)).toBe("none");
		expect(bodyKind(`${JS}\n`)).toBe("checked");
	});
});

describe("env and sudo in a chain", () => {
	for (const line of [
		"sudo env BASH_ENV=./evil.sh python3 x.py",
		"sudo -u root env -i ZDOTDIR=. python3 x.py",
		"timeout 5 sudo BASH_ENV=./evil.sh python3 x.py",
	]) {
		test(line, () => expect(bodyKind(`${line}\n`)).toBe("unchecked"));
	}
	test("an inert program naming env is text", () => {
		expect(bodyKind('grep env "$f"\nsudo rm "$f"\n')).toBe("checked");
	});
});
