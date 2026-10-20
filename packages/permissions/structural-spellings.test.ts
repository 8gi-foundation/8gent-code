/**
 * #4514 family 5: the command name or the target is assembled by the shell from variables, arrays,
 * parameter expansion, eval, command substitution, aliases and functions on the same line.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { blockedReason, commandArgvs } from "./always-blocked";
import { PermissionManager } from "./index";
import { structuralForms, unresolvedDeleteReason } from "./structural-spellings";

// The destructive part is assembled so no line of this file is itself one.
const RM = ["r", "m"].join("");
const row = (s: string) => s.replaceAll("%RM%", RM);
const blocked = (line: string): boolean =>
	commandArgvs(row(line)).some((argv) => blockedReason(argv) !== null);

describe("variables and arrays the line assigns (#4514 family 5)", () => {
	const wipes = [
		"r=%RM%; $r -rf /",
		"r=%RM%; ${r} -rf /",
		'r=%RM%; "$r" -rf /',
		"x=%RM%; eval $x -rf /",
		"x=r; y=m; $x$y -rf /",
		"x=r; x+=m; $x -rf /",
		"x=%RM%; y=-rf; z=/; $x $y $z",
		"d=/; %RM% -rf $d",
		'd=~; %RM% -rf "$d"',
		'h=$HOME; %RM% -rf "$h"',
		"%RM% -rf ${y:-/}",
		"x=1; x=/; %RM% -rf $x",
		"x=/; x=ls; %RM% -rf $x",
		"x='%RM% -rf /'; $x",
		"x='%RM% -rf /'; eval \"$x\"",
		"x='%RM% -rf /'; sh -c \"$x\"",
		'x=%RM%; bash -c "$x -rf /"',
		'a=(%RM% -rf /); "${a[@]}"',
		"a=(%RM% -rf /); ${a[0]} ${a[1]} ${a[2]}",
		"a=(/ /tmp); %RM% -rf ${a[1]}",
		"a=(%RM%); ${a[0]} -rf ~",
		"x=XXX%RM%; ${x:3} -rf /",
		"x=%RM%XX; ${x%XX} -rf /",
		"x=XX%RM%; ${x#XX} -rf /",
		"x=rXm; ${x/X/} -rf /",
		"x=RM; ${x,,} -rf /",
		"x=%RM%; ${x:$((0)):2} -rf /",
		"y=x; x=%RM%; ${!y} -rf /",
		"read c <<< %RM%; $c -rf /",
		"for c in ls %RM%; do $c -rf /; done",
		'c=ls; [ -z "$c" ] || c=%RM%; $c -rf /',
		"x=%RM%; sudo $x -rf /",
		"x=%RM%; xargs $x -rf <<< /",
		"export x=%RM%; bash -c '$x -rf /'",
	];
	for (const w of wipes) test(`blocks ${w}`, () => expect(blocked(w)).toBe(true));

	test("a branch the line may take is covered: every value of a variable counts", () => {
		expect(blocked("if true; then c=ls; else c=%RM%; fi; $c -rf /")).toBe(true);
		expect(blocked("if true; then c=%RM%; else c=ls; fi; $c -rf /")).toBe(true);
	});

	test("a quote the shell reading misjudges does not hide the assignment", () => {
		expect(blocked("echo \"${x#'\"'}\" ; x=%RM%; $x -rf / ; echo \\'")).toBe(true);
		expect(blocked("echo \"${x:-'}\"; x='%RM% -rf /'; eval \"$x\" #'")).toBe(true);
	});

	const fine = [
		"x=build; %RM% -rf $x",
		'd=./dist; %RM% -rf "$d"',
		"x=/tmp/a; %RM% -rf $x",
		"x=$HOME/proj; %RM% -rf $x/build",
		"%RM% -rf $TMPDIR/x",
		'%RM% -rf "${TMPDIR:-/tmp}/x"',
		"x=%RM%; echo $x",
		"x=%RM%; $x -f ./a",
		"x=ls; $x -la /",
		"CC=gcc; $CC -c x.c",
		"$EDITOR file",
		"n=3; echo ${n:-5}",
		"a=(x y); echo ${a[0]}",
		"echo '$x -rf /'",
	];
	for (const f of fine) test(`allows ${f}`, () => expect(blocked(f)).toBe(false));
});

describe("a command name the shell decides at run time (#4514 family 5)", () => {
	test("is judged as every guarded command when what follows is a wipe", () => {
		expect(blocked("$cmd -rf /")).toBe(true);
		expect(blocked("$cmd -rf ~")).toBe(true);
		expect(blocked("${cmd} -rf /")).toBe(true);
		expect(blocked("sudo $cmd -rf /")).toBe(true);
		expect(blocked("$cmd -R 000 /")).toBe(true); // as chmod
		expect(blocked("$cmd of=/dev/sda")).toBe(true);
	});
	test("an ordinary run-time command is not caught", () => {
		expect(blocked("$cmd -rf ./build")).toBe(false);
		expect(blocked("$cmd --version")).toBe(false);
		expect(blocked("$EDITOR /etc/hosts")).toBe(false);
	});
	test("blockedReason refuses a non-literal name only behind a wipe", () => {
		expect(blockedReason(["$c", "-rf", "/"])).not.toBeNull();
		expect(blockedReason(["$c", "-rf", "build"])).toBeNull();
	});
});

describe("command substitution that names the command or the target (#4514 family 5/6)", () => {
	const wipes = [
		"$(echo %RM%) -rf /",
		"`echo %RM%` -rf /",
		"$(printf %RM%) -rf /",
		"$(printf '%s' %RM%) -rf /",
		"$(echo -n %RM%) -rf /",
		'$(echo -e "\\x72m") -rf /',
		'%RM% -rf "$(echo /)"',
		"%RM% -rf $(printf %s /)",
		'eval "$(echo %RM% -rf /)"',
		'bash <<< "$(echo %RM%) -rf /"',
		"bash <<<\"$(printf '%RM% -rf /')\"",
		"x=$(echo %RM% -rf /); $x",
		"x=$(echo %RM%); $x -rf /",
		"$(cat f) -rf /",
		"`cat f` -rf /",
		"$(which %RM%) -rf /",
	];
	for (const w of wipes) test(`blocks ${w}`, () => expect(blocked(w)).toBe(true));

	const fine = [
		"echo $(echo hi)",
		"$(which node) -v",
		'd=$(mktemp -d); %RM% -rf "$d"',
		'%RM% -rf "$(pwd)/build"',
		"%RM% -rf $(cat list)",
		"`which node` --version",
	];
	for (const f of fine) test(`allows ${f}`, () => expect(blocked(f)).toBe(false));
});

describe("aliases and functions defined on the same line (#4514 family 5)", () => {
	const wipes = [
		"alias r=%RM%; r -rf /",
		"alias r='%RM% -rf'; r /",
		'f() { %RM% -rf "$1"; }; f /',
		"function f { %RM% -rf $1; }; f ~",
		'f() { "$@"; }; f %RM% -rf /',
		'f() { %RM% -rf "$@"; }; f ./a /',
		"f() { %RM% -rf $1; }; g() { f $1; }; g /",
		"f() { %RM% -rf /; }; f",
	];
	for (const w of wipes) test(`blocks ${w}`, () => expect(blocked(w)).toBe(true));

	const fine = [
		"alias ll='ls -la'; ll /",
		"f() { echo $1; }; f /",
		'f() { %RM% -rf "$1"; }; f ./build',
		"function f { %RM% -rf $1; }; f dist",
	];
	for (const f of fine) test(`allows ${f}`, () => expect(blocked(f)).toBe(false));
});

describe("structuralForms", () => {
	test("a line with nothing structural is returned as written", () => {
		expect(structuralForms("ls -la")).toEqual(["ls -la"]);
	});
	test("the line as written always comes first", () => {
		const forms = structuralForms("r=ls; $r -la") as string[];
		expect(forms[0]).toBe("r=ls; $r -la");
		expect(forms).toContain(" ls -la");
	});
	test("too many alternatives to enumerate is a refusal", () => {
		const vars = Array.from({ length: 8 }, (_, i) => `a${i}=1; a${i}=2; a${i}=3`).join("; ");
		const use = Array.from({ length: 8 }, (_, i) => `$a${i}`).join("");
		expect(structuralForms(`${vars}; echo ${use}`)).toBeNull();
		expect(blocked(`${vars}; echo ${use}`)).toBe(true);
	});
	test("a variable with too many values is a refusal", () => {
		const many = Array.from({ length: 40 }, (_, i) => `x=${i}`).join("; ");
		expect(structuralForms(`${many}; echo $x`)).toBeNull();
	});
});

afterAll(cleanupTempDirs);

describe("a recursive delete of an operand the line does not resolve must ask (#4514 family 5)", () => {
	const asks = [
		"%RM% -rf $DIR",
		'%RM% -rf "$DIR"',
		"%RM% -rf ${DIR}",
		"%RM% -rf ${TARGET:?}",
		"%RM% -rf ${DIR:-x}",
		"%RM% -rf $DIR/",
		"%RM% -rf $DIR/*",
		"%RM% -rf $(cat list)",
		"%RM% -rf `cat list`",
		'%RM% -rf "$(cat list)"',
		"%RM% -r -f $DIR",
		"%RM% -rf -- $DIR",
		"sudo %RM% -rf $DIR",
		"bash -c '%RM% -rf $DIR'",
		'eval "%RM% -rf $DIR"',
		"d=$(cat list); %RM% -rf $d",
		"d=$x; %RM% -rf $d",
		"d=a; d=$(cat list); %RM% -rf $d",
	];
	for (const a of asks)
		test(`asks ${a}`, () => expect(unresolvedDeleteReason(row(a))).not.toBeNull());

	const passes = [
		'd=$(mktemp -d); %RM% -rf "$d"',
		"d=`mktemp -d`; %RM% -rf $d",
		"d=$(mktemp -d /tmp/x.XXXX); %RM% -rf ${d}",
		"d=build; %RM% -rf $d",
		"d=./dist; %RM% -rf $d/",
		"for d in a b; do %RM% -rf $d; done",
		'%RM% -rf "$DIR/build"',
		"%RM% -rf ./build",
		"%RM% -f $DIR",
		"%RM% $DIR",
		"ls $DIR",
		"echo %RM% -rf $DIR",
	];
	for (const p of passes)
		test(`passes ${p}`, () => expect(unresolvedDeleteReason(row(p))).toBeNull());

	test("Infinite mode must ask: refused with no terminal, not auto-approved", async () => {
		const pm = new PermissionManager(path.join(tempDir("unresolved-"), "permissions.json"));
		pm.enableInfiniteMode();
		const log = console.log;
		console.log = () => {};
		const saved = process.env.EIGHT_HEADLESS;
		process.env.EIGHT_HEADLESS = "1";
		try {
			for (const line of asks.slice(0, 8).map(row)) {
				expect([line, pm.mustAskReason(line) !== null]).toEqual([line, true]);
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
			for (const line of passes.slice(0, 5).map(row)) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					true,
				]);
			}
		} finally {
			console.log = log;
			if (saved === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
			else process.env.EIGHT_HEADLESS = saved;
			pm.disableInfiniteMode();
		}
	});
});
