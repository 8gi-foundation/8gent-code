/**
 * /model in the real app on a short terminal (#140). The component tests render the
 * picker alone; this boots the whole shell, because the picker's room is whatever the
 * shell leaves it. At 14 and 10 rows the shell hides its banner, tab row and NOW strip
 * while the picker is open, so the picker opens with 3 or more rows and Enter picks the
 * marked one. At 24 rows the shell keeps its chrome.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { runAppHarness } from "./app-driver.js";

const harness = path.join(import.meta.dir, "model-picker-short.harness.tsx");

interface Frames {
	rows: number;
	open: string[];
	afterTwo: string[];
	atEnd: string[];
	switchedLine: string | null;
}

async function run(rows: number): Promise<Frames> {
	const events = await runAppHarness(harness, { HARNESS_ROWS: String(rows) });
	expect(events.find((e) => e.phase === "error")).toBeUndefined();
	return events.find((e) => e.phase === "frames") as unknown as Frames;
}

const modelRows = (f: string[]) => f.filter((l) => /model-\d\d:latest/.test(l));
const marked = (f: string[]) => f.filter((l) => l.includes("❯"));

describe("the model picker inside the whole app", () => {
	test("24 rows: the shell keeps its banner, tabs and NOW strip", async () => {
		const r = await run(24);
		const text = r.open.join("\n");
		expect(text).toContain("8gent Code");
		expect(text).toContain("Orchestrator");
		expect(text).toContain("READY");
		expect(modelRows(r.open).length).toBeGreaterThanOrEqual(3);
		expect(marked(r.open).length).toBe(1);
		expect(r.open.length).toBeLessThanOrEqual(24);
	}, 120_000);

	for (const rows of [14, 10]) {
		test(`${rows} rows: picker opens in the shell with 3+ rows, scrolls, and Enter takes the marked one`, async () => {
			const r = await run(rows);
			// The shell gave its chrome to the picker: no banner, no tab row.
			const text = r.open.join("\n");
			expect(text).not.toContain("8gent Code");
			expect(text).not.toContain("Orchestrator");
			// Footer and Esc line stay, and the frame fits the terminal.
			expect(text).toContain("Esc returns to the prompt");
			expect(text).toContain("palette");
			expect(r.open.length).toBeLessThanOrEqual(rows);
			expect(modelRows(r.open).length).toBeGreaterThanOrEqual(3);
			expect(marked(r.open)[0]).toContain("model-05:latest");
			expect(marked(r.open)[0]).toContain("✓");
			expect(text).toMatch(/\d+ more below/);
			// Two Down presses: the mark moved, still one marked row on screen.
			expect(marked(r.afterTwo)[0]).toContain("model-07:latest");
			// End of the list: the last model is marked and nothing is below it.
			expect(marked(r.atEnd).length).toBe(1);
			expect(marked(r.atEnd)[0]).toContain("model-13:latest");
			expect(r.atEnd.join("\n")).not.toContain("more below");
			// Enter took the marked row at the end of the list.
			expect(r.switchedLine).toBe("Model switched to: model-13:latest");
		}, 120_000);
	}
});
