import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BASE_LEVEL,
	LONG_CONTEXT_CHARS,
	MANY_FILES_THRESHOLD,
	REPEAT_FAILURE_THRESHOLD,
	decideThinking,
	filesNamedIn,
	ownerThinkingSetting,
	readOwnerThinkingSetting,
	thinkingStatusLabel,
} from "./thinking-decider";

describe("decideThinking: fast by default", () => {
	it("a plain question is low", () => {
		const d = decideThinking({ prompt: "what's in this folder" });
		expect(d.level).toBe("low");
		expect(d.signals).toEqual([]);
		expect(d.source).toBe("auto");
		expect(BASE_LEVEL).toBe("low");
	});

	it("a design request steps up one level", () => {
		const d = decideThinking({ prompt: "design the plug architecture across packages" });
		expect(d.level).toBe("medium");
		expect(d.signals).toEqual(["plan-or-design"]);
	});

	it("a request for a plan steps up", () => {
		expect(decideThinking({ prompt: "make a plan for the migration" }).level).toBe("medium");
	});

	it("an explicit ask steps up, in each wording", () => {
		for (const p of [
			"think hard about the race in the queue",
			"ultrathink this one",
			"please think carefully before you edit",
		]) {
			const d = decideThinking({ prompt: p });
			expect(d.level).toBe("medium");
			expect(d.signals).toEqual(["explicit-request"]);
		}
	});

	it("the same task failing twice steps up; once does not", () => {
		expect(
			decideThinking({ prompt: "fix it", failedTurnsInRow: REPEAT_FAILURE_THRESHOLD - 1 }).level,
		).toBe("low");
		const d = decideThinking({ prompt: "fix it", failedTurnsInRow: REPEAT_FAILURE_THRESHOLD });
		expect(d.level).toBe("medium");
		expect(d.signals).toEqual(["repeat-failure"]);
	});

	it("many files in play steps up", () => {
		expect(
			decideThinking({ prompt: "rename it", filesInPlay: MANY_FILES_THRESHOLD - 1 }).level,
		).toBe("low");
		expect(
			decideThinking({ prompt: "rename it", filesInPlay: MANY_FILES_THRESHOLD }).signals,
		).toEqual(["many-files"]);
	});

	it("a long pasted context steps up", () => {
		const long = "x".repeat(LONG_CONTEXT_CHARS);
		expect(decideThinking({ prompt: long.slice(1) }).level).toBe("low");
		expect(decideThinking({ prompt: long }).signals).toEqual(["long-context"]);
	});

	it("steps up one level per signal and stops at high", () => {
		const two = decideThinking({ prompt: "think hard and design the cache", failedTurnsInRow: 0 });
		expect(two.level).toBe("high");
		const all = decideThinking({
			prompt: `think hard, design the cache ${"x".repeat(LONG_CONTEXT_CHARS)}`,
			filesInPlay: 99,
			failedTurnsInRow: 9,
		});
		expect(all.signals.length).toBe(5);
		expect(all.level).toBe("high");
	});

	it("steps back down to low on the next ordinary turn", () => {
		expect(decideThinking({ prompt: "ultrathink the schema" }).level).toBe("medium");
		expect(decideThinking({ prompt: "now run the tests" }).level).toBe("low");
	});

	it("gives the same answer for the same input", () => {
		const input = { prompt: "design the queue", filesInPlay: 2 };
		expect(decideThinking(input)).toEqual(decideThinking(input));
	});
});

describe("decideThinking: the owner's setting", () => {
	const hard = { prompt: "think hard and design the cache", filesInPlay: 99 };

	it("never exceeds the cap", () => {
		const d = decideThinking({ ...hard, cap: "medium" });
		expect(d.level).toBe("medium");
		expect(d.capped).toBe(true);
		expect(decideThinking({ ...hard, cap: "low" }).level).toBe("low");
	});

	it("a cap above the pick changes nothing", () => {
		const d = decideThinking({ prompt: "design the cache", cap: "high" });
		expect(d.level).toBe("medium");
		expect(d.capped).toBe(false);
	});

	it("a cap of off holds the decider at its base, never above", () => {
		expect(decideThinking({ ...hard, cap: "off" }).level).toBe("low");
	});

	it("a fixed level overrides the signals, even a cap", () => {
		const d = decideThinking({ prompt: "what's in this folder", fixed: "high", cap: "low" });
		expect(d.level).toBe("high");
		expect(d.source).toBe("fixed");
		expect(decideThinking({ ...hard, fixed: "low" }).level).toBe("low");
	});

	it("a fixed max is kept, and a cap never lowers it", () => {
		const d = decideThinking({ prompt: "hi", fixed: "max", cap: "low" });
		expect(d.level).toBe("max");
		expect(decideThinking({ ...hard, cap: "max" }).level).toBe("high");
	});

	it("a fixed off is kept: nothing is sent", () => {
		expect(decideThinking({ prompt: "design the cache", fixed: "off" }).level).toBe("off");
	});
});

describe("owner thinking setting", () => {
	it("reads level and cap, and ignores anything else", () => {
		expect(ownerThinkingSetting({ thinking: { level: "high", cap: "medium" } })).toEqual({
			fixed: "high",
			cap: "medium",
		});
		expect(ownerThinkingSetting({ thinking: { level: "auto", cap: "high" } })).toEqual({
			cap: "high",
		});
		expect(ownerThinkingSetting({ thinking: { level: "ultra", cap: 3 } })).toEqual({});
		expect(ownerThinkingSetting({})).toEqual({});
		expect(ownerThinkingSetting(null)).toEqual({});
	});

	it("reads the settings file, and a missing or broken file means auto", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-"));
		const file = path.join(dir, "settings.json");
		expect(readOwnerThinkingSetting(file)).toEqual({});
		fs.writeFileSync(file, "{not json");
		expect(readOwnerThinkingSetting(file)).toEqual({});
		fs.writeFileSync(file, JSON.stringify({ thinking: { level: "low", cap: "medium" } }));
		expect(readOwnerThinkingSetting(file)).toEqual({ fixed: "low", cap: "medium" });
	});
});

describe("filesNamedIn", () => {
	it("finds distinct paths", () => {
		expect(
			filesNamedIn(
				"edit packages/eight/agent.ts and packages/eight/agent.ts then apps/tui/src/app.tsx",
			),
		).toEqual(["packages/eight/agent.ts", "apps/tui/src/app.tsx"]);
		expect(filesNamedIn("what is in this folder")).toEqual([]);
	});
});

describe("thinkingStatusLabel", () => {
	it("says the level and why, and when it was not sent", () => {
		const base = { level: "low", source: "auto", capped: false, applied: true } as const;
		expect(thinkingStatusLabel(base)).toBe("think low");
		expect(thinkingStatusLabel({ ...base, level: "high", source: "fixed" })).toBe(
			"think high (set)",
		);
		expect(thinkingStatusLabel({ ...base, level: "medium", capped: true })).toBe(
			"think medium (capped)",
		);
		expect(thinkingStatusLabel({ ...base, applied: false })).toBe("think low, not sent");
		expect(thinkingStatusLabel({ ...base, level: "max", source: "fixed" })).toBe(
			"think max (set), sent as high",
		);
		expect(thinkingStatusLabel({ ...base, level: "max", applied: false })).toBe(
			"think max, not sent",
		);
	});
});
