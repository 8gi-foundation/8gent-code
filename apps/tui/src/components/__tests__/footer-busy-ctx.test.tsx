import { describe, expect, test } from "bun:test";
import { buildFooterSegments, fitFooterRow } from "../StatusFooter.js";

const busy = {
	mode: "Planning",
	turnRunning: true,
	turnCalls: 12,
	daemonAttached: true,
	traceHint: "open" as const,
	ctx: { used: 125000, window: 131072, stale: false },
};

describe("footer while a turn runs keeps the full-window warning and the stop key", () => {
	for (const columns of [60, 80, 100]) {
		test(`${columns} columns`, () => {
			const row = fitFooterRow(buildFooterSegments({ ...busy, columns }), columns);
			const keys = row.segments.map((s) => s.key);
			expect(keys).toContain("stop");
			if (columns >= 80) expect(keys).toContain("ctx");
		});
	}
});
