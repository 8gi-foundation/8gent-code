import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPABILITY_CLASSES,
	RouterBandit,
	armKey,
	defaultBanditStorePath,
	isCapabilityClass,
	seededRng,
} from "./router-bandit";

describe("capability classes", () => {
	it("exposes exactly the five task classes in a stable order", () => {
		expect([...CAPABILITY_CLASSES]).toEqual(["code", "writing", "tool-use", "vision", "judge"]);
	});

	it("guards membership", () => {
		expect(isCapabilityClass("code")).toBe(true);
		expect(isCapabilityClass("vision")).toBe(true);
		expect(isCapabilityClass("summarize")).toBe(false);
		expect(isCapabilityClass(7)).toBe(false);
	});

	it("keys arms as provider:model", () => {
		expect(armKey({ provider: "ollama", model: "qwen2.5vl:7b" })).toBe("ollama:qwen2.5vl:7b");
	});

	it("defaults the store under ~/.8gent", () => {
		expect(defaultBanditStorePath()).toMatch(/\.8gent[\\/]router-bandit\.json$/);
	});
});

describe("RouterBandit.select", () => {
	it("returns null when there is nothing to choose", () => {
		const b = new RouterBandit({ rng: seededRng(1) });
		expect(b.select("code")).toBeNull();
	});

	it("only ever returns a registered candidate", () => {
		const b = new RouterBandit({ rng: seededRng(1) });
		const cands = [
			{ provider: "8gent", model: "eight-1.0-q3:14b" },
			{ provider: "ollama", model: "qwen2.5-coder:7b" },
		];
		const pick = b.select("code", cands);
		expect(pick).not.toBeNull();
		expect(cands.map(armKey)).toContain(armKey(pick!));
	});

	it("learns to prefer the arm that consistently wins", () => {
		// Deterministic RNG so the assertion is stable, not flaky.
		const b = new RouterBandit({ rng: seededRng(42) });
		const good = { provider: "forge", model: "ornith-1.0-9b" };
		const bad = { provider: "8gent", model: "eight-1.0-q3:14b" };

		// Feed real outcomes: `good` wins on code, `bad` loses.
		for (let i = 0; i < 50; i++) {
			b.record("code", good, { quality: 1 });
			b.record("code", bad, { quality: 0 });
		}

		// Over many draws the bandit should pick the winner the large majority of
		// the time (Thompson sampling still explores, so not 100%).
		let goodPicks = 0;
		for (let i = 0; i < 200; i++) {
			const pick = b.select("code", [good, bad]);
			if (pick && armKey(pick) === armKey(good)) goodPicks++;
		}
		expect(goodPicks).toBeGreaterThan(180);
	});

	it("keeps classes independent - a code winner does not bias writing", () => {
		const b = new RouterBandit({ rng: seededRng(7) });
		const coder = { provider: "forge", model: "ornith-1.0-9b" };
		const writer = { provider: "8gent", model: "eight-1.0-q3:14b" };
		for (let i = 0; i < 40; i++) {
			b.record("code", coder, { quality: 1 });
			b.record("code", writer, { quality: 0 });
			b.record("writing", writer, { quality: 1 });
			b.record("writing", coder, { quality: 0 });
		}
		expect(armKey(b.best("code")!)).toBe(armKey(coder));
		expect(armKey(b.best("writing")!)).toBe(armKey(writer));
	});
});

describe("RouterBandit.record + telemetry", () => {
	it("tracks pulls, mean quality, and latency/cost EMAs", () => {
		const b = new RouterBandit();
		const arm = { provider: "forge", model: "ornith-1.0-9b" };
		b.record("tool-use", arm, { quality: 1, latencyMs: 1000, costUsd: 0 }, 100);
		b.record("tool-use", arm, { quality: 0, latencyMs: 2000, costUsd: 0 }, 200);

		const [row] = b.winRates("tool-use");
		expect(row.pulls).toBe(2);
		expect(row.meanQuality).toBeCloseTo(0.5, 5);
		// EMA(alpha=0.2): seed 1000, then 1000 + 0.2*(2000-1000) = 1200.
		expect(row.latencyMsEma).toBeCloseTo(1200, 5);
		expect(row.costUsdEma).toBeCloseTo(0, 5);
	});

	it("clamps out-of-range and non-finite rewards into [0,1]", () => {
		const b = new RouterBandit();
		const arm = { provider: "x", model: "y" };
		b.record("judge", arm, { quality: 5 });
		b.record("judge", arm, { quality: -3 });
		b.record("judge", arm, { quality: Number.NaN });
		const [row] = b.winRates("judge");
		// Clamped to 1, 0, 0 -> mean 1/3.
		expect(row.meanQuality).toBeCloseTo(1 / 3, 5);
	});

	it("ranks win-rates highest mean first", () => {
		const b = new RouterBandit();
		b.record("writing", { provider: "a", model: "1" }, { quality: 0.2 });
		b.record("writing", { provider: "b", model: "2" }, { quality: 0.9 });
		b.record("writing", { provider: "c", model: "3" }, { quality: 0.5 });
		const rows = b.winRates("writing");
		expect(rows.map((r) => r.provider)).toEqual(["b", "c", "a"]);
	});
});

describe("RouterBandit persistence", () => {
	it("round-trips stats through disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "router-bandit-"));
		const path = join(dir, "router-bandit.json");
		try {
			const b = new RouterBandit();
			const arm = { provider: "forge", model: "ornith-1.0-9b" };
			for (let i = 0; i < 5; i++) b.record("code", arm, { quality: 1, latencyMs: 800 });
			b.save(path);

			const loaded = RouterBandit.load(path);
			const [row] = loaded.winRates("code");
			expect(row.provider).toBe("forge");
			expect(row.pulls).toBe(5);
			expect(row.meanQuality).toBeCloseTo(1, 5);
			expect(row.latencyMsEma).toBeCloseTo(800, 5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("starts empty (never throws) when the file is missing or corrupt", () => {
		const dir = mkdtempSync(join(tmpdir(), "router-bandit-"));
		const missing = join(dir, "nope.json");
		const corrupt = join(dir, "corrupt.json");
		try {
			expect(RouterBandit.load(missing).arms("code")).toEqual([]);
			require("node:fs").writeFileSync(corrupt, "{ not json", "utf-8");
			expect(RouterBandit.load(corrupt).arms("code")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("back-fills classes missing from an older document", () => {
		const partial = {
			version: 1 as const,
			// Only one class present, as an older/partial file might be.
			classes: { code: {} } as never,
		};
		const b = new RouterBandit({ state: partial });
		// Every class is addressable without throwing.
		for (const cls of CAPABILITY_CLASSES) {
			expect(b.arms(cls)).toEqual([]);
		}
	});
});
