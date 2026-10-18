/**
 * #4173: a variable the command line assigns itself is read from that
 * assignment, and every way an assignment could smuggle a path outside the
 * workspace is refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import evidence from "./__tests__/fixtures/4173-inline-var-commands.json";
import overnight from "./__tests__/fixtures/artale-overnight-magick.json";
import { type BoundaryHost, checkCommandBoundary } from "./src/workspace-boundary";

type Row = [command: string, allowed: boolean];

const WS = "/home/dev/proj";
const HOST = {
	platform: "linux" as const,
	env: { HOME: "/home/dev", PATH: "/usr/bin:/bin:/home/dev/.local/bin" },
};
/** The host already has D pointing outside, so a binding the shell never makes would hide it. */
const HOST_WITH_D = { ...HOST, env: { ...HOST.env, D: "/etc" } };

const allowed = (command: string, host: Partial<BoundaryHost> = HOST, ws = WS) =>
	checkCommandBoundary(command, ws, [], host).allowed;

describe("the commands that failed on 13 October", () => {
	const host = { platform: "darwin" as const, env: { HOME: "/Users/dev", PATH: "/usr/bin" } };

	test("all eight are fixture rows and each assigns D before using it", () => {
		expect(evidence.commands).toHaveLength(8);
		for (const command of evidence.commands) expect(command).toStartWith("D=/Users/dev/");
	});

	evidence.commands.forEach((command, i) => {
		test(`step ${22 + i} is allowed: $D is read from its own assignment`, () => {
			expect(allowed(command, host, evidence.workspaceRoot)).toBe(true);
		});
	});

	test("the same line pointed outside the workspace is still refused", () => {
		const outside = evidence.commands[0].replace(/^D=[^;]+;/, "D=/Users/dev/Documents;");
		const result = checkCommandBoundary(outside, evidence.workspaceRoot, [], host);
		expect(result.allowed).toBe(false);
		expect(result.violations[0].resolved).toBe("/Users/dev/Documents/frames");
	});
});

describe("in-line assignments inside the workspace are allowed", () => {
	const rows: Row[] = [
		['D=/home/dev/proj/out; mkdir -p "$D/frames"', true],
		['D=/home/dev/proj/out && mkdir -p "$D/frames" && magick a.png "$D/frames/01.png"', true],
		['D=/home/dev/proj/out\nmkdir -p "$D/frames"', true],
		['export D=/home/dev/proj/out; magick in.png "${D}/a.png"', true],
		['readonly D=/home/dev/proj/out; cp a.png "$D/b.png"', true],
		['D=/home/dev/proj/out; export D; cp a.png "$D/b.png"', true],
		['D=out; mkdir -p "$D/frames"', true],
		["D='/home/dev/proj/out'; cp a.png \"$D/b.png\"", true],
		['D="/home/dev/proj/out"; cp a.png "$D/b.png"', true],
		['D=~/proj/out; cp a.png "$D/b.png"', true],
		['A=/home/dev/proj; B=$A/out; cp a.png "$B/b.png"', true],
		['A=/home/dev/proj B=$A/out; cp a.png "$B/b.png"', true],
		['D=/etc; D=/home/dev/proj/out; cp a.png "$D/b.png"', true],
		['D=out; for i in 1 2; do magick a.png "$D/s-$i.png"; done', true],
		["D=out; cd src && cp a.png ../$D/b.png", true],
		['D=/home/dev/proj/src; cd "$D" && cat main.ts', true],
		["N=3; cp a.png out-$N.png", true],
	];
	for (const [command, ok] of rows) {
		test(`allows ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(ok);
		});
	}
});

describe("an assignment cannot smuggle a path outside", () => {
	const rows: [label: string, command: string][] = [
		// Absolute paths
		["absolute path", 'D=/etc; cat "$D/passwd"'],
		["absolute path used bare (allowed on main)", "D=/etc; rm -rf $D"],
		["absolute path in braces", "D=/etc; cat ${D}/passwd"],
		["absolute path as a flag operand", "D=/etc; tee --output=$D/passwd"],
		["exported absolute path", "export D=/etc; cat $D/passwd"],
		["cd into it (allowed on main)", "D=/etc; cd $D; cat passwd"],
		// Dot-dot
		["dot-dot from the root", "D=/home/dev/proj/../../../etc; cat $D/passwd"],
		["relative dot-dot", "D=..; cat $D/secret.txt"],
		["dot-dot hidden inside", "D=out/../..; cat $D/secret.txt"],
		["dot-dot after a cd", "D=../secret.txt; cd src; cat ../$D"],
		// A second variable
		["chained through a second variable", "E=/etc; D=$E; cat $D/passwd"],
		["host variable that points outside", "D=$HOME/.ssh; cat $D/id_rsa"],
		["host variable set nowhere", "D=$NOPE/etc; cat $D/passwd"],
		["parameter expansion with a default", "D=${NOPE:-/etc}; cat $D/passwd"],
		["second variable that was unresolvable", "E=$(echo /etc); D=$E/x; cat $D"],
		// Command substitution
		["command substitution", "D=$(echo /etc); cat $D/passwd"],
		["quoted command substitution", 'D="$(echo /etc)"; cat "$D/passwd"'],
		["backticks", "D=`echo /etc`; cat $D/passwd"],
		["command substitution, used where main read nothing", "D=$(echo /etc); cat $D"],
		["backticks inside double quotes", 'D="`pwd`"; cat "$D/../secret.txt"'],
		// Process substitution: the value is a /dev/fd path the shell makes up at run time
		["input process substitution", "D=<(echo /etc); cat $D/passwd"],
		["output process substitution", "D=>(cat); cp secret.txt $D"],
		// An operator on a bound name, with an expansion or an outside path inside it
		["default holding a command substitution", "D=/home/dev/proj/x; cat ${D:-$(echo /etc)}/passwd"],
		["default holding a host variable", "D=/home/dev/proj/x; cat ${D:-$HOME}/.ssh/id_rsa"],
		["default holding backticks", 'D=/home/dev/proj/x; cat "${D:-`pwd`}/a"'],
		["indirection through a bound name", "D=/home/dev/proj/x; E=D; cat ${!E}/a"],
		["a bound name beside a host one", "D=/home/dev/proj/x; cat $D/a $OUT/b"],
		["a host variable set nowhere, embedded", "D=src$SUFFIX; cat $D/main.ts"],
		["cd into a variable the line also reads", "D=src; read D; cd $D; cat passwd"],
		["a colon in the value is a path, not a search list", "D=/etc:/home/dev/proj; ls $D"],
		// Word splitting
		["whitespace splits into two paths", 'D="/home/dev/proj/a /etc/passwd"; cat $D'],
		["IFS splits on a colon", "IFS=:; D=/home/dev/proj/a:/etc/passwd; cat $D"],
		["IFS splits a search list (allowed on main)", "IFS=:; rm -rf $PATH"],
		// Assignments the shell may not make, or makes differently
		["append", "D=/home/dev/proj/x; D+=/../../../etc; cat $D/passwd"],
		["read", "D=/home/dev/proj/x; read D; cat $D/passwd"],
		["for loop variable", "D=/home/dev/proj/x; for D in /etc; do cat $D/passwd; done"],
		["unset", 'D=/home/dev/proj/x; unset D; cat "$D/passwd"'],
		["declare", "D=/home/dev/proj/x; declare D=/etc; cat $D/passwd"],
		["export with a flag", "export -n D=/home/dev/proj/x; cat $D/passwd"],
		[
			"assigned inside a loop body",
			"D=/home/dev/proj/x\nwhile false; do\nD=/etc\ndone\ncat $D/passwd",
		],
		["shell-maintained PWD", "PWD=/home/dev/proj/a/b/c; cd .; cat $PWD/../../../x"],
		["HOME reassigned before a tilde", "HOME=/etc; cat ~/proj/passwd"],
		["CDPATH reassigned before a cd", "CDPATH=/; cd etc; cat passwd"],
		["sourced file", "D=/home/dev/proj/x; source ./env.sh; cat $D/a"],
		["eval", 'D=/home/dev/proj/x; eval "$(cat env)"; cat $D/a'],
		["trap", "D=/home/dev/proj/x; trap 'D=/etc' DEBUG; cat $D/passwd"],
	];
	for (const [label, command] of rows) {
		test(`refuses ${label}: ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(false);
		});
	}
});

describe("a binding the shell never makes does not hide the host value", () => {
	const rows: [label: string, command: string][] = [
		["after &&", "false && D=/home/dev/proj/x; cat $D/a"],
		["after ||", "true || D=/home/dev/proj/x; cat $D/a"],
		["piped", "D=/home/dev/proj/x | true; cat $D/a"],
		["after a pipe", "true | D=/home/dev/proj/x; cat $D/a"],
		["backgrounded", "D=/home/dev/proj/x & cat $D/a"],
		["inside if", "if false; then\nD=/home/dev/proj/x\nfi\ncat $D/a"],
		["inside a brace group", "{ D=/home/dev/proj/x; }; cat $D/a"],
		["inside a subshell", "(D=/home/dev/proj/x); cat $D/a"],
		["inside command substitution", "echo $(true; D=/home/dev/proj/x); cat $D/a"],
		["inside a heredoc", "cat <<EOF\nD=/home/dev/proj/x\nEOF\ncat $D/a"],
		["quoted, so a command name", '"D=/home/dev/proj/x"; cat $D/a'],
		["a prefix assignment", "D=/home/dev/proj/x cat $D/a"],
		["escaped dollar", "D=/home/dev/proj/x; cat \\$D/a"],
		["double dollar", "D=/home/dev/proj/x; cat $$D/a"],
	];
	for (const [label, command] of rows) {
		test(`refuses ${label}: ${JSON.stringify(command)}`, () => {
			expect(allowed(command, HOST_WITH_D)).toBe(false);
		});
	}
});

describe("refusals say why", () => {
	test("an unresolvable value names the variable and is reported as unresolved", () => {
		const result = checkCommandBoundary("D=$(echo /etc); cat $D/passwd", WS, [], HOST);
		const v = result.violations.find((x) => x.raw === "$D/passwd");
		expect(v?.resolved).toBe("<unresolved>");
		expect(v?.reason).toContain("cannot follow");
	});

	test("a resolved value outside is reported where it really points", () => {
		const result = checkCommandBoundary('D=/etc; cat "$D/passwd"', WS, [], HOST);
		expect(result.violations.map((v) => v.resolved)).toEqual(["/etc/passwd"]);
	});
});

describe("host variables keep their old reading", () => {
	const rows: Row[] = [
		["cat $HOME/.ssh/id_rsa", false],
		["echo $PATH", true],
		['for f in a b; do cat "$f.txt"; done', true],
		["awk '{print $1}' src/data.csv", true],
	];
	for (const [command, ok] of rows) {
		test(`${ok ? "allows" : "denies"} ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(ok);
		});
	}
});

describe("on win32 PowerShell reads $D as its own unset variable", () => {
	const host = {
		platform: "win32" as const,
		env: { USERPROFILE: "C:\\Users\\dev", PATH: "C:\\Windows" },
	};
	test("the line stays refused under the Windows reading", () => {
		expect(
			allowed('D=C:/Users/dev/proj/out; mkdir "$D/frames"', host, "C:\\Users\\dev\\proj"),
		).toBe(false);
	});
});

describe("second review: every other way the shell can bind or rewrite a name", () => {
	const refused: [label: string, command: string][] = [
		["default operator on a bound name", "D=; cat ${D:-/etc}/passwd"],
		["alternate operator on a bound name", "D=x; cat ${D:+/etc}/passwd"],
		["suffix strip", "D=/etc; cat ${D%/}/passwd"],
		["prefix strip", "D=/etc; cat ${D#x}/passwd"],
		["substitution", "D=/etc; cat ${D/x/y}/passwd"],
		["array element", "D=(/etc); cat ${D[0]}/passwd"],
		["indirection", "E=HOME; cat ${!E}/.ssh/id_rsa"],
		["default operator on a host name", "cat ${NOPE:-/etc}/passwd"],
		["default operator in double quotes", 'cat "${NOPE:-/etc}/passwd"'],
		["bare cd goes to HOME", "cd; cat .ssh/id_rsa"],
		["bare cd after HOME is set", "HOME=/etc; cd; cat passwd"],
		["cd - with OLDPWD set", "OLDPWD=/etc; cd -; cat passwd"],
		["cd - with no earlier cd", "cd -; cat passwd"],
		["read with no plain assignment", "read D < list.txt; cat $D"],
		["loop over command substitution", "for D in $(cat list.txt); do cat $D; done"],
		["loop over a variable", "for D in $X; do cat $D; done"],
		["loop over a value with whitespace", 'for D in "a /etc"; do cat $D; done'],
		["loop over a brace expansion", "for D in {a,/etc}; do cat $D; done"],
		["positional loop", "for D; do cat $D; done"],
		["reference before an assignment in a loop body", "for i in 1 2; do cat $D; D=/etc; done"],
		["function body runs after the assignment", "f() { cat $D; }; D=/etc; f"],
		["function keyword body runs after the assignment", "function f { cat $D; }; D=/etc; f"],
		["source can set any name", "source ./env.sh; cat $D"],
		["eval after a keyword", "if true; then eval 'D=/etc'; fi; cat $D"],
		["loop variable read inside the loop", "for f in a b; do read f; cat $f; done"],
		["loop variable with IFS set", "IFS=x; for f in x//etc; do cat $f; done"],
		["loop value of dots", "for f in .; do cat .$f/secret.txt; done"],
		["cd into a loop with two values", "for f in src out; do cd $f; done; cat ../../x"],
	];
	for (const [label, command] of refused) {
		test(`refuses ${label}: ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(false);
		});
	}

	const kept: Row[] = [
		['for f in *.png; do magick "$f" "out/$f"; done', true],
		["for f in src; do cd $f; cat ../a.txt; done", true],
		["for a in o; do for b in ut; do cp x.png $a$b/x.png; done; done", true],
		["for i in 1 2 3; do echo $i; done", true],
		["cd src; cd -; cat a.txt", true],
		["cd src && cd - && cat a.txt", true],
		["for f in /etc; do cat $f; done", false],
		["for a in ..; do cat $a/x; done", false],
	];
	for (const [command, ok] of kept) {
		test(`${ok ? "allows" : "denies"} ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(ok);
		});
	}
});

describe("third review: an empty or unrun loop, and a cd that lands on -", () => {
	// After `for f in; do`, a real shell leaves $f as it was: here unset, so `$f/etc` is `/etc`.
	const refused: [label: string, command: string][] = [
		["empty for list, then a read", "for f in; do :; done; cat $f/etc/passwd"],
		["empty for list, then a copy out", "for f in; do :; done; cp secret $f/tmp/exfil"],
		["empty for list with a space", "for f in ; do :; done; cat $f/etc/passwd"],
		["empty select list", "select f in; do :; done; cat $f/etc/passwd"],
		["empty list after a full one", "for f in a; do :; done; for f in; do :; done; cat $f/x"],
		[
			"empty list, a read, then a full one",
			"for f in; do :; done; cat $f/etc/passwd; for f in a; do :; done",
		],
		["empty for list, then a cd", "for f in; do :; done; cd $f/etc; cat passwd"],
		["a variable that is -", "D=-; cd $D; cat passwd"],
		["a loop value that is -", "for d in -; do cd $d; done; cat passwd"],
		["a variable that is -, after an option", "D=-; cd -P $D; cat passwd"],
		["cd -P -", "cd -P -; cat passwd"],
		["cd -L -", "cd -L -; cat passwd"],
		["cd -- -", "cd -- -; cat passwd"],
		["cd -P with no operand goes to HOME", "cd -P; cat .ssh/id_rsa"],
		["cd -P to an absolute path", "cd -P /etc; cat passwd"],
		["cd -- to an absolute path", "cd -- /etc; cat passwd"],
		["a variable that is -, with OLDPWD set", "OLDPWD=/etc; cd src; D=-; cd $D; cat passwd"],
		// A loop binds its name only once it has run, in this shell.
		["a read before the loop", "cat $f/etc/passwd; for f in a; do :; done"],
		["a cd before the loop", "cd $f/etc; for f in a; do :; done; cat passwd"],
		["a loop that may not run", "false && for f in a; do :; done; cat $f/etc/passwd"],
		["a loop after ||", "true || for f in a; do :; done; cat $f/etc/passwd"],
		["a loop inside an if", "if false; then for f in a; do :; done; fi; cat $f/etc/passwd"],
		["a loop inside an empty loop", "for g in; do for f in a; do :; done; done; cat $f/etc/passwd"],
		["a loop inside a while", "while false; do for f in a; do :; done; done; cat $f/etc/passwd"],
		["a piped loop runs in a subshell", "for f in a; do :; done | cat; cat $f/etc/passwd"],
		["a background loop runs in a subshell", "for f in a; do :; done & cat $f/etc/passwd"],
		["a redirect on done expands first", "for f in a; do :; done > $f/etc/x"],
		["a select value can be empty", "select f in a; do cat $f/etc/passwd; break; done"],
		// 8SO review: a loop in `then` never ran for the `else` or `elif` branch.
		[
			"a loop in then, read in else",
			"if false; then for f in a; do :; done; else cat $f/etc/passwd; fi",
		],
		[
			"a loop in then, read in elif",
			"if false; then for f in a; do :; done; elif true; then cat $f/etc/passwd; fi",
		],
		// 8SO review: under nullglob a glob list can be empty, so the loop may not run.
		[
			"a glob loop under nullglob",
			"shopt -s nullglob; for f in *.none; do :; done; cat $f/etc/passwd",
		],
		["a glob loop, read after it", "for f in *.png; do :; done; cat $f/etc/passwd"],
		["a bracket glob loop, read after it", "for f in [ab]; do :; done; cat $f/etc/passwd"],
	];
	for (const [label, command] of refused) {
		test(`refuses ${label}: ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(false);
		});
	}

	const kept: Row[] = [
		["for f in a; do :; done; cat $f/x", true],
		['for f in *.png; do magick "$f" "out/$f"; done', true],
		["cd src; D=-; cd $D; cat a.txt", true],
		["cd src; for d in -; do cd $d; done; cat a.txt", true],
		["cd src; cd -P -; cat a.txt", true],
		["cd -P src; cat ../a.txt", true],
		["cd -L -- src; cat a.txt", true],
		["cd src; D=-; cd $D; cat ../x", false],
		["for a in o; do for b in ut; do :; done; cp x.png $a$b/x.png; done", true],
		["for f in a; do :; done; for f in b; do :; done; cat $f/x", true],
		["for f in a; do cat $f/x; done | cat", true],
		["for f in a\ndo\n:\ndone\ncat $f/x", true],
		["if true; then for f in a; do :; done; cat $f/x; fi", true],
		["if false; then :; else for f in a; do :; done; cat $f/x; fi", true],
		["for f in *.png; do :; done; for f in a; do cat $f/x; done", true],
	];
	for (const [command, ok] of kept) {
		test(`${ok ? "allows" : "denies"} ${JSON.stringify(command)}`, () => {
			expect(allowed(command)).toBe(ok);
		});
	}

	test("the eight artale-overnight commands that assign D are still allowed", () => {
		const ws = "/Users/dev/work";
		const host = { platform: "darwin" as const, env: { HOME: "/Users/dev", PATH: "/usr/bin" } };
		const calls = overnight.calls.filter((c) => c.command.startsWith("D={WS}/"));
		expect(calls.map((c) => c.step)).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
		for (const c of calls) {
			expect(allowed(c.command.replaceAll("{WS}", ws), host, ws)).toBe(true);
		}
	});
});

describe("symlinks on a real filesystem", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-inline-ws-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-inline-out-"));
	fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
	fs.mkdirSync(path.join(ws, "out"));
	let linked = true;
	try {
		fs.symlinkSync(outside, path.join(ws, "escape-link"));
	} catch {
		linked = false;
	}
	afterAll(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});

	test("an absolute value through a symlink that leaves the workspace is refused", () => {
		if (!linked) return;
		const link = path.join(ws, "escape-link").replaceAll("\\", "/");
		expect(checkCommandBoundary(`D=${link}; cat "$D/secret.txt"`, ws).allowed).toBe(false);
	});

	test("a relative value through the same symlink is refused", () => {
		if (!linked) return;
		expect(checkCommandBoundary('D=escape-link; cat "$D/secret.txt"', ws).allowed).toBe(false);
	});

	test("a loop value that is a symlink out of the workspace is refused, through cd too", () => {
		if (!linked) return;
		const check = (c: string) => checkCommandBoundary(c, ws).allowed;
		expect(check('for f in escape-link; do cat "$f/secret.txt"; done')).toBe(false);
		expect(check("for f in escape-link; do cd $f; cat secret.txt; done")).toBe(false);
		// On Windows the line is also read as cmd.exe and PowerShell, where `$f` is not a loop
		// variable the boundary can follow, so it is refused there by design.
		if (process.platform !== "win32")
			expect(check("for f in out; do cd $f; cat ../x.txt; done")).toBe(true);
	});

	test("a cd after a reserved word is tracked, bound or literal", () => {
		if (!linked) return;
		const check = (c: string) => checkCommandBoundary(c, ws).allowed;
		expect(check("if true; then cd escape-link; fi; cat secret.txt")).toBe(false);
		expect(check("if :; then D=escape-link; fi; cd $D; cat secret.txt")).toBe(false);
		expect(check("{ cd escape-link; cat secret.txt; }")).toBe(false);
	});

	test("a real directory inside is allowed", () => {
		// A POSIX shell reads a backslash as an escape, so a Windows path goes in as Git Bash takes it.
		const out = path.join(ws, "out").replaceAll("\\", "/");
		expect(checkCommandBoundary(`D=${out}; mkdir -p "$D/frames"`, ws).allowed).toBe(true);
	});
});
