/**
 * Destructive-guard bypasses through variables, parameter expansion, quoting
 * and the working directory (#3314), and the read-only allowlist missing a `$`
 * inside double quotes (#3315).
 *
 * Every command below is SYNTHETIC, written for this file, and is PROMPT /
 * PARSER TEXT ONLY: nothing is ever executed.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { readOnlyAllowlist } from "./allowlist";
import { decideRules } from "./rules";

const HOME = homedir();

function verdicts(
	cases: string[],
	opts?: { cwd?: string },
): { command: string; verdict: string }[] {
	return cases.map((command) => ({ command, verdict: decideRules(command, opts).verdict }));
}
const all = (cases: string[], verdict: string) => cases.map((command) => ({ command, verdict }));

// ----- #3314: same-line assignments --------------------------------------------

describe("#3314 a recursive delete of a variable assigned earlier on the line", () => {
	const corpus = [
		// home held in a variable, deleted bare, double-quoted, single-quoted
		"D=$HOME; rm -rf $D",
		'D=$HOME; rm -rf "$D"',
		"D=$HOME; rm -rf '$D'",
		'D="$HOME" && rm -rf "$D"',
		'D=~; rm -rf "$D"',
		'export D="$HOME"; rm -rf "$D"',
		'export D=$HOME && rm -rf "${D}"',
		'D=/; rm -rf "$D"',
		"D=/usr; rm -rf $D",
		'D=/etc && rm -r "$D"',
		// a chain of assignments
		'A=$HOME; B=$A; rm -rf "$B"',
		// a home top-level folder through a variable
		'D=$HOME; rm -rf "$D/Documents"',
		'D=$HOME; rm -rf "$D"/*',
		// inside bash -c, still one command line
		"bash -c 'D=$HOME; rm -rf \"$D\"'",
	];
	it("blocks every shape", () => expect(verdicts(corpus)).toEqual(all(corpus, "block")));

	it("a reassigned HOME still blocks (assignments only add candidates)", () =>
		expect(decideRules('HOME=/tmp/x; rm -rf "$HOME"').verdict).toBe("block"));

	it("a harmless assignment stays escalate, never pass", () => {
		const ok = ['D=build; rm -rf "$D"', 'D=./dist && rm -rf "$D"', "OUT=/tmp/x; rm -rf $OUT"];
		expect(verdicts(ok)).toEqual(all(ok, "escalate"));
	});

	it("a prefix assignment does not change the expansion in the same command", () =>
		// sh expands $D before `D=/` applies, so the real value is unknown: escalate.
		expect(decideRules('D=/ rm -rf "$D"').verdict).toBe("escalate"));
});

// ----- #3314: parameter-expansion forms ------------------------------------------

describe("#3314 parameter-expansion forms of the home directory", () => {
	const corpus = [
		"rm -rf ${HOME:?}",
		'rm -rf "${HOME:?}"',
		"rm -rf '${HOME:?}'",
		'rm -rf "${HOME:?home unset}"',
		"rm -rf ${HOME}/*",
		'rm -rf "${HOME}"/*',
		"rm -rf '${HOME}/*'",
		"rm -rf $HOME/.*",
		'rm -rf "$HOME"/.*',
		"rm -rf '$HOME/.*'",
		'rm -rf "${HOME:-/tmp/x}"',
		'rm -rf "${HOME-/tmp/x}"',
		'rm -rf "${X:-$HOME}"',
		'rm -rf "${X:-${HOME}}"',
		'rm -rf "${X:=$HOME}"',
		'rm -rf "${HOME:?}/Documents"',
	];
	it("blocks every shape", () => expect(verdicts(corpus)).toEqual(all(corpus, "block")));
});

describe("#3314 an unset variable expands to nothing (fail closed)", () => {
	const corpus = [
		// the Steam installer shape: empty $DIR leaves `/*`
		'rm -rf "$DIR/"*',
		'rm -rf "$DIR"/*',
		"rm -rf $DIR/*",
		"rm -rf '$DIR/'*",
		'rm -rf "${DIR}/"*',
		'rm -rf "$1"/*',
		'rm -rf "$DIR/usr"',
	];
	it("blocks when the empty expansion lands on a system path", () =>
		expect(verdicts(corpus)).toEqual(all(corpus, "block")));

	it("${VAR:?} refuses the empty expansion, so the safe idiom stays escalate", () => {
		const ok = [
			'rm -rf "${DIR:?}"/*',
			'rm -rf "${DIR:?}/build"',
			'rm -rf "$DIR"',
			'rm -rf "$DIR/build"',
		];
		expect(verdicts(ok)).toEqual(all(ok, "escalate"));
	});
});

// ----- #3314: cwd-relative targets --------------------------------------------

describe("#3314 cwd-relative targets when the working directory is home or a system path", () => {
	const targets = ["*", ".", "./*", ".*", "'*'", '"."', '"./*"', "'.*'"];
	it("blocks with cwd = the home directory", () => {
		const cs = targets.map((t) => `rm -rf ${t}`);
		expect(verdicts(cs, { cwd: HOME })).toEqual(all(cs, "block"));
	});
	it("blocks with cwd = a system path", () => {
		const cs = targets.map((t) => `rm -rf ${t}`);
		expect(verdicts(cs, { cwd: "/" })).toEqual(all(cs, "block"));
		expect(verdicts(cs, { cwd: "/usr" })).toEqual(all(cs, "block"));
	});
	it("blocks after a cd into home or a system path on the same line", () => {
		const cs = [
			"cd ~ && rm -rf *",
			"cd && rm -rf .",
			'cd "$HOME"; rm -rf ./*',
			"cd / ; rm -rf .*",
			"cd /usr && rm -rf '*'",
			'D=$HOME; cd "$D" && rm -rf *',
		];
		expect(verdicts(cs)).toEqual(all(cs, "block"));
	});
	it("stays escalate in a project directory or when the cwd is unknown", () => {
		const cs = targets.map((t) => `rm -rf ${t}`);
		expect(verdicts(cs, { cwd: `${HOME}/code/project` })).toEqual(all(cs, "escalate"));
		expect(verdicts(cs)).toEqual(all(cs, "escalate"));
		expect(decideRules("cd ~ && cd /tmp/x && rm -rf *").verdict).toBe("escalate");
	});
});

// ----- #3315: allowlist `$` inside double quotes -------------------------------

describe("#3315 a $ expansion inside double quotes is no-opinion", () => {
	it("cat, ls and find given a quoted variable go to the judge", () => {
		for (const c of [
			'cat "$F"',
			'ls "${HOME}"',
			'find "$X" -name a',
			'head -5 "a/$F"',
			'wc -l "\\\\$F"',
		]) {
			expect({ c, v: readOnlyAllowlist(c).verdict }).toEqual({ c, v: "no-opinion" });
		}
	});
	it("a $ in single quotes, an escaped $ in double quotes and $? keep their verdicts", () => {
		for (const c of ["echo '$HOME'", "echo $?", 'echo "\\$HOME"', 'echo "done: $?"']) {
			expect({ c, v: readOnlyAllowlist(c).verdict }).toEqual({ c, v: "pass-without-model" });
		}
	});
});
