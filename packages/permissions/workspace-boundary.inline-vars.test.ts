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
		const link = path.join(ws, "escape-link");
		expect(checkCommandBoundary(`D=${link}; cat "$D/secret.txt"`, ws).allowed).toBe(false);
	});

	test("a relative value through the same symlink is refused", () => {
		if (!linked) return;
		expect(checkCommandBoundary('D=escape-link; cat "$D/secret.txt"', ws).allowed).toBe(false);
	});

	test("a real directory inside is allowed", () => {
		expect(
			checkCommandBoundary(`D=${path.join(ws, "out")}; mkdir -p "$D/frames"`, ws).allowed,
		).toBe(true);
	});
});
