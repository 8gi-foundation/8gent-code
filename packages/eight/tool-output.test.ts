import { describe, expect, test } from "bun:test";
import { TOOL_OUTPUT_CAP, keepToolOutput } from "./tool-output";

describe("keepToolOutput", () => {
	test("keeps a result under the cap exactly", () => {
		expect(keepToolOutput("abc")).toBe("abc");
		const edge = "x".repeat(TOOL_OUTPUT_CAP);
		expect(keepToolOutput(edge)).toBe(edge);
	});
	test("over the cap keeps the head and the tail and says how much went", () => {
		const big = `START${"m".repeat(100_000)}END`;
		const kept = keepToolOutput(big);
		expect(kept.startsWith("START")).toBe(true);
		expect(kept.endsWith("END")).toBe(true);
		expect(kept).toContain("characters not kept");
		expect(kept.length).toBeLessThan(TOOL_OUTPUT_CAP + 60);
	});
});
