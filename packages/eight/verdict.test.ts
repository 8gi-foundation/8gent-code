import { describe, expect, it } from "bun:test";
import { LocalVerdict } from "./verdict";

// All tests point the underlying judges at an unroutable local port
// (127.0.0.1:1). No test performs any network egress: every path resolves
// through the providers layer's fail-closed defaults.
const OFFLINE = {
	selene: { baseUrl: "http://127.0.0.1:1", timeoutMs: 500 },
	skywork: { baseUrl: "http://127.0.0.1:1", timeoutMs: 500 },
};

describe("LocalVerdict.judge", () => {
	it("fails closed to FAIL when Selene is unreachable", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		const v = await verdict.judge("some output", "some rubric");
		expect(v.pass).toBe(false);
		expect(v.source).toBe("fail-closed");
		expect(v.rationale).toContain("unreachable");
	});
});

describe("LocalVerdict.score", () => {
	it("ranks every candidate null and last-by-id when Skywork is down", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		const ranked = await verdict.score([
			{ id: "z", output: "one" },
			{ id: "a", output: "two" },
		]);
		expect(ranked.every((c) => c.score === null)).toBe(true);
		expect(ranked.map((c) => c.id)).toEqual(["a", "z"]);
	});

	it("returns an empty ranking for no candidates", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		expect(await verdict.score([])).toEqual([]);
	});
});

describe("LocalVerdict.best", () => {
	it("yields no winner when no candidate could be scored", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		const best = await verdict.best([
			{ id: "a", output: "one" },
			{ id: "b", output: "two" },
		]);
		// A silent reward model must not crown a false winner.
		expect(best).toBeNull();
	});

	it("yields no winner for an empty candidate set", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		expect(await verdict.best([])).toBeNull();
	});
});

describe("LocalVerdict.isAvailable", () => {
	it("reports both judges unreachable when offline", async () => {
		const verdict = new LocalVerdict(OFFLINE);
		expect(await verdict.isAvailable()).toEqual({ selene: false, skywork: false });
	});
});

describe("LocalVerdict construction", () => {
	it("constructs with an empty config object without throwing", () => {
		// The API must be usable with no wiring; endpoints default to localhost.
		expect(() => new LocalVerdict({})).not.toThrow();
		expect(() => new LocalVerdict()).not.toThrow();
	});
});
