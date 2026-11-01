/**
 * The temp-dir guard itself (#3285): which leftovers fail a run, which are
 * only reported, which are ignored, and which old run dirs are swept.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupTempDirs, tempDir } from "./temp-dirs";
import { GUARDED_PREFIXES, leftovers, staleRunDirs } from "./temp-guard";

afterAll(cleanupTempDirs);

/** The prefixes #3285 reported and this guard now holds. */
const FIXED = [
	"sys1-nocal-",
	"s1-rm-nocal-",
	"subagent-guards-",
	"perm-mode-nocal-",
	"s1-allow-nocal-",
	"open-on-write-",
	"s1-own-nocal-",
	"bashgate-exec-",
	"lesson-collector-",
	"trace-capture-",
	"local-delegation-",
];

function fixture(names: string[]): string {
	const dir = tempDir("temp-guard-fixture-");
	for (const n of names) mkdirSync(join(dir, n));
	return dir;
}

describe("leftovers(): the guarded / other / ignored split", () => {
	test("every prefix #3285 fixed is guarded", () => {
		const dir = fixture(FIXED.map((p) => `${p}AbC123`));
		const { guarded, other } = leftovers(dir);
		expect(guarded).toEqual(FIXED.map((p) => `${p}AbC123`).sort());
		expect(other).toEqual([]);
	});

	test("subagent-guards-home- is guarded through the subagent-guards- prefix", () => {
		const dir = fixture(["subagent-guards-home-x1y2z3", "subagent-guards-q9w8e7"]);
		expect(leftovers(dir).guarded).toEqual([
			"subagent-guards-home-x1y2z3",
			"subagent-guards-q9w8e7",
		]);
	});

	test("an unfixed prefix is reported, not failed; the test home is ignored", () => {
		const dir = fixture(["bdh-Xttd8m", "8gent-test-home-k2j3h4", "sys1-cal-abcdef"]);
		expect(leftovers(dir)).toEqual({ guarded: ["sys1-cal-abcdef"], other: ["bdh-Xttd8m"] });
	});

	test("a missing dir has no leftovers", () => {
		expect(leftovers(join(tempDir("temp-guard-missing-"), "nope"))).toEqual({
			guarded: [],
			other: [],
		});
	});

	test("the guarded list is not empty", () => {
		expect(GUARDED_PREFIXES.length).toBeGreaterThanOrEqual(FIXED.length);
	});
});

describe("staleRunDirs(): only old run dirs of dead processes", () => {
	const HOUR = 60 * 60 * 1000;
	test("dead and old is stale; alive, young, own, unnamed and old-format are not", () => {
		const parent = fixture([
			"8gent-test-tmp-111-aaaaaa", // dead, old -> stale
			"8gent-test-tmp-222-bbbbbb", // alive, old
			"8gent-test-tmp-333-cccccc", // dead, young
			`8gent-test-tmp-${process.pid}-dddddd`, // this run
			"8gent-test-tmp-eeeeee", // pre-pid name: never swept
			"sys1-nocal-ffffff", // not a run dir
		]);
		const now = Date.now();
		const old = (now - 7 * HOUR) / 1000;
		for (const n of [
			"8gent-test-tmp-111-aaaaaa",
			"8gent-test-tmp-222-bbbbbb",
			`8gent-test-tmp-${process.pid}-dddddd`,
			"8gent-test-tmp-eeeeee",
			"sys1-nocal-ffffff",
		]) {
			utimesSync(join(parent, n), old, old);
		}
		const alive = (pid: number) => pid === 222;
		expect(staleRunDirs(parent, now, 6 * HOUR, alive)).toEqual(["8gent-test-tmp-111-aaaaaa"]);
	});
});

describe("the preload", () => {
	test("os.tmpdir() answers this run's own dir", () => {
		expect(resolve(tmpdir())).toMatch(new RegExp(`8gent-test-tmp-${process.pid}-[^\\\\/]+$`));
	});
});
