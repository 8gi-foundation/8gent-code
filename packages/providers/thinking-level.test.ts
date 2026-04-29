import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ProviderManager } from "./index";
import type { ThinkingLevel } from "../types/index.js";
import {
	THINKING_LEVELS_ORDERED,
	resolveThinkingForRouting,
	resolveThinkingLevel,
	thinkingTokenMultiplier,
} from "./thinking-level";

const ALL: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

describe("THINKING_LEVELS_ORDERED", () => {
	it("is ordered minimal to high", () => {
		expect(THINKING_LEVELS_ORDERED).toEqual(["minimal", "low", "medium", "high"]);
	});
});

describe("resolveThinkingLevel", () => {
	it("returns the requested level when supported", () => {
		expect(resolveThinkingLevel("high", ALL)).toBe("high");
		expect(resolveThinkingLevel("medium", ALL)).toBe("medium");
		expect(resolveThinkingLevel("low", ALL)).toBe("low");
		expect(resolveThinkingLevel("minimal", ALL)).toBe("minimal");
	});

	it("downgrades high to medium when high is unsupported", () => {
		expect(resolveThinkingLevel("high", ["minimal", "low", "medium"])).toBe("medium");
	});

	it("walks the chain high -> medium -> low -> minimal", () => {
		expect(resolveThinkingLevel("high", ["minimal"])).toBe("minimal");
		expect(resolveThinkingLevel("high", ["minimal", "low"])).toBe("low");
		expect(resolveThinkingLevel("high", ["minimal", "low", "medium"])).toBe("medium");
	});

	it("downgrades medium past gaps in support", () => {
		expect(resolveThinkingLevel("medium", ["minimal"])).toBe("minimal");
		expect(resolveThinkingLevel("medium", ["minimal", "high"])).toBe("minimal");
	});

	it("never upgrades a request", () => {
		expect(resolveThinkingLevel("low", ["high"])).toBeNull();
		expect(resolveThinkingLevel("minimal", ["medium", "high"])).toBeNull();
	});

	it("returns null when the provider supports no thinking", () => {
		expect(resolveThinkingLevel("high", [])).toBeNull();
		expect(resolveThinkingLevel("minimal", [])).toBeNull();
	});

	it("ignores duplicates in the supported list", () => {
		expect(resolveThinkingLevel("high", ["minimal", "minimal", "low"])).toBe("low");
	});

	it("rejects unknown thinking levels defensively", () => {
		expect(resolveThinkingLevel("ultra" as ThinkingLevel, ALL)).toBeNull();
	});
});

describe("thinkingTokenMultiplier", () => {
	it("returns monotonically increasing multipliers from minimal to high", () => {
		const minimal = thinkingTokenMultiplier("minimal");
		const low = thinkingTokenMultiplier("low");
		const medium = thinkingTokenMultiplier("medium");
		const high = thinkingTokenMultiplier("high");
		expect(minimal).toBeLessThan(low);
		expect(low).toBeLessThan(medium);
		expect(medium).toBeLessThan(high);
	});

	it("returns 1.0 baseline for null and undefined", () => {
		expect(thinkingTokenMultiplier(null)).toBe(1.0);
		expect(thinkingTokenMultiplier(undefined)).toBe(1.0);
	});

	it("returns >1 for any active thinking level", () => {
		for (const level of ALL) {
			expect(thinkingTokenMultiplier(level)).toBeGreaterThan(1.0);
		}
	});
});

describe("resolveThinkingForRouting", () => {
	it("flags downgraded:false when the level is honored as-is", () => {
		const r = resolveThinkingForRouting("medium", ALL);
		expect(r.level).toBe("medium");
		expect(r.downgraded).toBe(false);
		expect(r.requested).toBe("medium");
	});

	it("flags downgraded:true when the resolved level differs", () => {
		const r = resolveThinkingForRouting("high", ["minimal", "low"]);
		expect(r.level).toBe("low");
		expect(r.downgraded).toBe(true);
		expect(r.requested).toBe("high");
	});

	it("does not flag downgrade when the provider supports nothing", () => {
		const r = resolveThinkingForRouting("high", []);
		expect(r.level).toBeNull();
		expect(r.downgraded).toBe(false);
		expect(r.tokenMultiplier).toBe(1.0);
	});

	it("includes the token multiplier matching the resolved level", () => {
		expect(resolveThinkingForRouting("high", ALL).tokenMultiplier).toBe(
			thinkingTokenMultiplier("high"),
		);
		expect(resolveThinkingForRouting("high", ["minimal"]).tokenMultiplier).toBe(
			thinkingTokenMultiplier("minimal"),
		);
	});
});

describe("ProviderManager.resolveThinking", () => {
	let tmpSettings: string;
	let manager: ProviderManager;

	beforeEach(() => {
		tmpSettings = path.join(os.tmpdir(), `thinking-level-test-${Date.now()}-${Math.random()}.json`);
		manager = new ProviderManager(tmpSettings);
	});

	afterEach(() => {
		if (fs.existsSync(tmpSettings)) fs.unlinkSync(tmpSettings);
	});

	it("honors high thinking on Anthropic without downgrade", () => {
		const r = manager.resolveThinking("high", "anthropic");
		expect(r.level).toBe("high");
		expect(r.downgraded).toBe(false);
	});

	it("honors high thinking on OpenAI without downgrade", () => {
		const r = manager.resolveThinking("high", "openai");
		expect(r.level).toBe("high");
		expect(r.downgraded).toBe(false);
	});

	it("returns null when routing to Ollama (no thinking support)", () => {
		const r = manager.resolveThinking("high", "ollama");
		expect(r.level).toBeNull();
		expect(r.downgraded).toBe(false);
		expect(r.tokenMultiplier).toBe(1.0);
	});

	it("uses the active provider when no providerName is given", () => {
		manager.setActiveProvider("anthropic");
		const r = manager.resolveThinking("medium");
		expect(r.level).toBe("medium");
	});
});
