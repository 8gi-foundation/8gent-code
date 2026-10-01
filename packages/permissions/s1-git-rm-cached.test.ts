/**
 * System One: `git rm --cached` only untracks (#3298).
 *
 * Pilot l5-feature-e2e (main 132555b2, run 2026-10-01_172135) ran
 * `git rm --cached .8gent/state.db .8gent/state.db-shm .8gent/state.db-wal`.
 * The rules pass it, so the Selene judge was asked and blocked it
 * (pYes=0.6764). `--cached` removes paths from the index and leaves the files
 * on disk, so the allowlist now passes it without the judge.
 *
 * Plain `git rm <file>` deletes the file from the working tree. It keeps its
 * treatment: no allowlist pass, the judge decides. A chained `rm` is still
 * caught by the rules.
 *
 * Commands here are parser text only. Nothing is executed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyAllowlist } from "../decide/allowlist";
import { type Decider, createDecider } from "../decide/index";
import { decideRules } from "../decide/rules";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

const PILOT = "git rm --cached .8gent/state.db .8gent/state.db-shm .8gent/state.db-wal";

const passes = (c: string) => readOnlyAllowlist(c).verdict === "pass-without-model";

describe("allowlist: git rm --cached (#3298)", () => {
	test("the exact pilot command passes without the judge", () => {
		expect(decideRules(PILOT).verdict).toBe("pass");
		expect(readOnlyAllowlist(PILOT)).toEqual({
			verdict: "pass-without-model",
			reason: "read-only",
		});
	});

	test("recursive and flag-order variants pass", () => {
		for (const c of [
			"git rm -r --cached .8gent",
			"git rm --cached -r .8gent",
			"git rm -rf --cached node_modules",
			"git rm --cached -rq --ignore-unmatch dist",
			"git rm --cached -- .8gent/state.db",
			"git rm --cached --dry-run -r .",
			"git -C ../other rm --cached a.txt",
			"git rm --cached a.txt && git status",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});

	test("plain git rm, which deletes from disk, is never passed", () => {
		for (const c of [
			"git rm a.txt",
			"git rm -r src",
			"git rm -rf src",
			"git rm -f a.txt",
			"git rm -- --cached", // `--cached` after `--` is a path, not the flag
			"git rm --cached", // no path
			"git rm --cache a.txt", // abbreviation: no opinion, judge decides
			"git rm --cached --no-cached a.txt", // negation undoes --cached
			"git rm --cached --pathspec-from-file=list.txt",
			"git rm --cached a.txt && git rm b.txt",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("a chained rm is still caught by the rules and never passed", () => {
		const c = "git rm --cached a && rm -rf b";
		expect(decideRules(c)).toMatchObject({ verdict: "escalate", rule: "rm_recursive" });
		expect(passes(c)).toBe(false);
		for (const x of [
			"git rm --cached a; rm b.txt",
			"git rm --cached a || rm -f src/x.ts",
			"git rm --cached a | xargs rm",
		]) {
			expect({ x, rules: decideRules(x).verdict }).toEqual({ x, rules: "escalate" });
			expect({ x, pass: passes(x) }).toEqual({ x, pass: false });
		}
	});

	test("a secret path or a substitution is still no-opinion", () => {
		expect(passes("git rm --cached .env")).toBe(false);
		expect(passes("git rm --cached $(cat list)")).toBe(false);
		expect(passes("git rm --cached `ls`")).toBe(false);
	});
});

// A judge that answers "yes, harmful" to everything and counts how often it is asked.
class BlockingBackend implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.999 },
					confidence: 0.999,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

describe("gate: git rm --cached (#3298)", () => {
	let backend: BlockingBackend;
	// The pilot's setting: EIGHT_SYSTEM_ONE=1, allowlist on by default.
	const env = { [SYSTEM_ONE_FLAG]: "1" };

	beforeEach(() => {
		_resetSystemOne();
		backend = new BlockingBackend();
		_setSystemOneOverridesForTests({
			createDecider: (): Decider => createDecider({ backend, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: mkdtempSync(join(tmpdir(), "s1-git-rm-cached-")),
		});
	});
	afterEach(() => _resetSystemOne());

	test("the pilot command runs and the judge is not asked", async () => {
		const r = await systemOneGate(PILOT, env);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(backend.asks).toBe(0);
	});

	test("plain git rm still goes past the allowlist and is not run by it", async () => {
		const r = await systemOneGate("git rm a.txt", env);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("the chained rm is still stopped", async () => {
		const r = await systemOneGate("git rm --cached a && rm -rf b", env);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
		expect(r.guard?.rule).toBe("rm_recursive");
	});
});
