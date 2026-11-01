import { describe, expect, it } from "bun:test";
import type { Host } from "./host-placement";
import {
	DEFAULT_PLACEMENT_CONFIG,
	estimateModelMemoryGb,
	isLatencyCritical,
	placeArm,
} from "./host-placement";

// The two-Mac fabric from the issue: helm = fast primary, forge = heavy 96GB box.
function helm(overrides: Partial<Host> = {}): Host {
	return { id: "helm", memoryGb: 36, latencyMs: 2, reachable: true, ...overrides };
}
function forge(overrides: Partial<Host> = {}): Host {
	return { id: "forge", memoryGb: 96, latencyMs: 12, reachable: true, ...overrides };
}

describe("latency-critical classes", () => {
	it("treats inline tool-use and judge as latency-critical, generation as heavy", () => {
		expect(isLatencyCritical("tool-use")).toBe(true);
		expect(isLatencyCritical("judge")).toBe(true);
		expect(isLatencyCritical("code")).toBe(false);
		expect(isLatencyCritical("writing")).toBe(false);
		expect(isLatencyCritical("vision")).toBe(false);
	});

	it("honours a caller override", () => {
		const config = {
			...DEFAULT_PLACEMENT_CONFIG,
			latencyCritical: { ...DEFAULT_PLACEMENT_CONFIG.latencyCritical, code: true },
		};
		expect(isLatencyCritical("code", config)).toBe(true);
	});
});

describe("estimateModelMemoryGb", () => {
	it("scales with parameter count and quant tag", () => {
		// 14b at q3 -> 14 * 0.5 = 7GB.
		expect(estimateModelMemoryGb("eight-1.0-q3:14b")).toBeCloseTo(7, 5);
		// 27b at q4 -> 27 * 0.6 = 16.2GB.
		expect(estimateModelMemoryGb("qwen2.5vl-q4:27b")).toBeCloseTo(16.2, 5);
	});

	it("reads fractional param counts", () => {
		// 1.5b at default 0.7 -> 1.05GB.
		expect(estimateModelMemoryGb("qwen2.5:1.5b")).toBeCloseTo(1.05, 5);
	});

	it("uses the fp16 factor for full-precision names", () => {
		// 7b at fp16 -> 7 * 2.1 = 14.7GB.
		expect(estimateModelMemoryGb("llama-3-fp16:7b")).toBeCloseTo(14.7, 5);
	});

	it("falls back to the unknown footprint when no param count is present", () => {
		expect(estimateModelMemoryGb("apple-foundationmodel")).toBe(
			DEFAULT_PLACEMENT_CONFIG.unknownModelGb,
		);
	});

	it("does not mistake a hex-ish or worded name for a param count", () => {
		expect(estimateModelMemoryGb("gpt-oss")).toBe(DEFAULT_PLACEMENT_CONFIG.unknownModelGb);
	});
});

describe("placeArm - routing", () => {
	const arm14b = { provider: "8gent", model: "eight-1.0-q3:14b" };
	const arm70b = { provider: "ollama", model: "llama-3.1-q4:70b" };

	it("sends latency-critical work to the low-latency host that fits", () => {
		const d = placeArm("tool-use", arm14b, [helm(), forge()]);
		expect(d).not.toBeNull();
		expect(d?.host.id).toBe("helm");
		expect(d?.latencyCritical).toBe(true);
		expect(d?.reason).toContain("latency-critical");
	});

	it("sends heavy generation to the roomiest host", () => {
		const d = placeArm("code", arm14b, [helm(), forge()]);
		expect(d?.host.id).toBe("forge");
		expect(d?.latencyCritical).toBe(false);
		expect(d?.reason).toContain("heavy");
	});

	it("routes a model too big for helm to forge even when latency-critical", () => {
		// 70b at q4 -> ~42GB + 2 headroom = 44GB: exceeds helm's 36, fits forge's 96.
		const d = placeArm("tool-use", arm70b, [helm(), forge()]);
		expect(d?.host.id).toBe("forge");
	});

	it("fails closed to cloud (null) when no reachable host can fit the model", () => {
		const d = placeArm("code", arm70b, [helm({ memoryGb: 36 }), forge({ memoryGb: 40 })]);
		expect(d).toBeNull();
	});

	it("fails closed to cloud (null) when nothing is reachable", () => {
		const d = placeArm("tool-use", arm14b, [
			helm({ reachable: false }),
			forge({ reachable: false }),
		]);
		expect(d).toBeNull();
	});

	it("skips an unreachable host and places on the survivor", () => {
		const d = placeArm("tool-use", arm14b, [helm({ reachable: false }), forge()]);
		expect(d?.host.id).toBe("forge");
	});

	it("honours an explicit requiredGb over the name estimate", () => {
		// The name says small, but the caller knows it needs 50GB: only forge fits.
		const d = placeArm("tool-use", arm14b, [helm(), forge()], { requiredGb: 50 });
		expect(d?.host.id).toBe("forge");
		expect(d?.requiredGb).toBe(50);
	});

	it("is deterministic across equal hosts via a stable id tie-break", () => {
		const a: Host = { id: "beta", memoryGb: 64, latencyMs: 5, reachable: true };
		const b: Host = { id: "alpha", memoryGb: 64, latencyMs: 5, reachable: true };
		// Heavy class, identical memory and latency -> id order decides ("alpha").
		expect(placeArm("code", arm14b, [a, b])?.host.id).toBe("alpha");
		expect(placeArm("code", arm14b, [b, a])?.host.id).toBe("alpha");
	});

	it("breaks latency ties toward the leaner box", () => {
		const fast64: Host = { id: "big", memoryGb: 64, latencyMs: 3, reachable: true };
		const fast32: Host = { id: "small", memoryGb: 32, latencyMs: 3, reachable: true };
		// Same latency, latency-critical -> prefer the leaner host to leave room elsewhere.
		expect(placeArm("judge", arm14b, [fast64, fast32])?.host.id).toBe("small");
	});
});
