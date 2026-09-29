/**
 * Finding: a safety gate that asks a model "is this command dangerous?" must
 * fail CLOSED. Any error, missing backend, or probability that is not a finite
 * number in [0, 1] has to be "block", never "allow". A NaN compared with a
 * threshold is false in every direction, so a guard written as
 * `if (p > blockAbove) block; else allow` silently allows on NaN.
 *
 * Pinned code: packages/decide/guard.ts bashGuard(), PR 2995 (Eight System One
 * M1, authored by James Spalding, not an Artale commit). It is in this suite
 * because it is the same fail-closed rule Artale established for recall in
 * PR 2984: a failure must never look like a safe answer.
 * credit: Artale (8SO), for the principle
 *
 * No network, no models: stub deciders, the deterministic MockBackend, and a
 * fetch stub that refuses every request.
 */
import { describe, expect, test } from "bun:test";
import { bashGuard, createDecider, MockBackend } from "../../packages/decide/index";

type Noul = Parameters<typeof bashGuard>[1];

/** A decider whose noul() returns a fixed yes-probability. */
function fixed(pYes: unknown): Noul {
	return {
		noul: async () =>
			({
				probabilities: { yes: pYes, no: 1 - Number(pYes) },
				backend: "stub",
				model: "stub",
				latencyMs: 0,
			}) as never,
	};
}

/** fetch that never reaches the network. */
const refuse = async (): Promise<Response> => {
	throw new TypeError("network disabled in security tests");
};

describe("bashGuard fails closed (PR 2995)", () => {
	test("decider throws -> block", async () => {
		const r = await bashGuard("ls", {
			noul: async () => {
				throw new Error("backend exploded");
			},
		});
		expect(r.verdict).toBe("block");
		expect(Number.isNaN(r.pYes)).toBe(true);
	});

	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.5, 42]) {
		test(`probability ${bad} -> block`, async () => {
			expect((await bashGuard("ls", fixed(bad))).verdict).toBe("block");
		});
	}

	for (const bad of [undefined, null, "0.1", {}]) {
		test(`non-numeric probability ${JSON.stringify(bad) ?? "undefined"} -> block`, async () => {
			expect((await bashGuard("ls", fixed(bad))).verdict).toBe("block");
		});
	}

	test("decider returns nothing at all -> block", async () => {
		expect((await bashGuard("ls", { noul: async () => undefined as never })).verdict).toBe("block");
	});

	test("backend unavailable (auto-detect, network refused) -> block", async () => {
		const decider = createDecider({ backend: "auto", fetch: refuse, env: {} });
		const r = await bashGuard("ls", decider);
		expect(r.verdict).toBe("block");
		expect(r.backend).toBe("unavailable");
	});

	test("backend unavailable (ollama selected, unreachable) -> block", async () => {
		const decider = createDecider({ backend: "ollama", fetch: refuse, env: {} });
		expect((await bashGuard("ls", decider)).verdict).toBe("block");
	});

	test("a valid low probability -> allow (the only allow path)", async () => {
		const r = await bashGuard("ls", fixed(0.05));
		expect(r.verdict).toBe("allow");
		expect(r.pYes).toBe(0.05);
	});

	test("a valid high probability -> block, and the escalate band escalates", async () => {
		expect((await bashGuard("x", fixed(0.95))).verdict).toBe("block");
		expect((await bashGuard("x", fixed(0.5))).verdict).toBe("escalate");
	});

	test("end to end through the real decider with the offline mock backend", async () => {
		const decider = createDecider({ backend: new MockBackend() });
		expect((await bashGuard("ls", decider)).verdict).toBe("allow");
		// The mock scores word overlap with the guard question, so a command
		// quoting its danger words scores high. Deterministic, no model.
		const risky = "delete overwrite exfiltrate data change system state irreversibly running this";
		expect((await bashGuard(risky, decider)).verdict).toBe("block");
	});
});
