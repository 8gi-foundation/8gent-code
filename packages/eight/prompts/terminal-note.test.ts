import { describe, expect, it } from "bun:test";
import { buildToolCatalogSegment } from "./system-prompt";

describe("terminal tab guidance stays out of the shared catalog", () => {
	it("neither catalog carries a terminal tab note", () => {
		for (const concise of [true, false]) {
			const text = buildToolCatalogSegment({ concise });
			expect(text).not.toContain("never reaches a tab");
			expect(text).not.toContain("Terminal tabs:");
		}
	});
});
