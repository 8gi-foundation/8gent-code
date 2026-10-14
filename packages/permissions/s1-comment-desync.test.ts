/**
 * System One gate, default mode (EIGHT_SYSTEM_ONE unset), no judge, headless
 * (#3303 re-review of #3304).
 *
 * With no judge, the default mode runs whatever the rules pass. The quote
 * masker and segment splitter do not model comments, so an apostrophe in a
 * `# it's` comment hid the next line from the rules: a final rules block
 * became a silent run. bash also decodes `$'\x2d...'`, which the rules do not.
 * The rules now escalate any unquoted word-start `#` (shell_comment) and any
 * `$'` / `$"` (ansi_c_or_locale_quote). Escalate with no person is a block.
 *
 * Parser text only: nothing here is executed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decider } from "../decide/index";
import { decideRules } from "../decide/rules";
import { _resetSystemOne, _setSystemOneOverridesForTests, systemOneGate } from "./system-one-gate";

/** The reviewer's three cases. */
const HIDDEN = [
	"ls # it's\nrm -rf ~ #'", // comment desync hides a home-dir recursive delete
	"ls # it's\nfind . -delete #'", // comment desync hides find's delete action
	"find . $'\\x2ddelete'", // ANSI-C quoting: bash decodes it to -delete
];

describe("rules: comments and ANSI-C quoting escalate (#3303)", () => {
	test("each hidden case escalates or blocks", () => {
		for (const c of HIDDEN)
			expect({ c, v: decideRules(c).verdict === "pass" }).toEqual({ c, v: false });
		expect(decideRules(HIDDEN[0]).rules).toContain("shell_comment");
		expect(decideRules(HIDDEN[2]).rules).toContain("ansi_c_or_locale_quote");
	});

	test("a quoted or mid-word # does not fire", () => {
		for (const c of [
			"grep -n '#' notes.md",
			'grep -rn " #" src',
			"git commit -m 'Closes #12'",
			'git commit -m "fix: handle # in names"',
			"echo a#b",
			"echo ${#x}",
			"echo $#",
			"echo '$'",
			'echo "cost: $"',
		])
			expect({ c, rules: decideRules(c).rules }).toEqual({ c, rules: [] });
	});

	test('a real comment fires; so does $" locale quoting', () => {
		for (const c of ["ls # note", "ls;#x", "bun test 2>&1 | tail -5 # check", 'echo $"hi"'])
			expect({ c, v: decideRules(c).verdict }).toEqual({ c, v: "escalate" });
	});
});

describe("gate: default mode, no judge, headless (#3303)", () => {
	let headlessWas: string | undefined;
	let calDir: string;
	const def: Record<string, string | undefined> = {}; // EIGHT_SYSTEM_ONE unset

	beforeEach(() => {
		_resetSystemOne();
		headlessWas = process.env.EIGHT_HEADLESS;
		process.env.EIGHT_HEADLESS = "1";
		calDir = mkdtempSync(join(tmpdir(), "s1-comment-nocal-"));
		_setSystemOneOverridesForTests({
			createDecider: () =>
				({
					backend: async () => {
						throw new Error("no decide backend available");
					},
				}) as unknown as Decider,
			askHuman: async () => null,
			calibrationDir: calDir,
		});
	});
	afterEach(() => {
		_resetSystemOne();
		if (headlessWas === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		else process.env.EIGHT_HEADLESS = headlessWas;
		rmSync(calDir, { recursive: true, force: true });
	});

	test("the three hidden cases do not run", async () => {
		for (const c of HIDDEN) {
			const r = await systemOneGate(c, def);
			expect({ c, run: r.run, backend: r.guard?.backend }).toEqual({
				c,
				run: false,
				backend: "rules-only",
			});
			expect(["escalate", "block"]).toContain(r.guard?.verdict ?? "");
		}
	});

	test("ordinary commands with a quoted # still run", async () => {
		for (const c of ["grep -n '#' notes.md", "git commit -m 'Closes #12'"]) {
			const r = await systemOneGate(c, def);
			expect({ c, run: r.run }).toEqual({ c, run: true });
		}
	});
});
