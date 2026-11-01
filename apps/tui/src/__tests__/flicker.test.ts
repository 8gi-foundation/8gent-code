/**
 * #4970 (epic #4938): the TUI must not strobe while 8gent works, on a phone-sized terminal.
 *
 * Drives the real App through one working turn (a tool call, the spinner,
 * then about three seconds of streamed text) at 52x30 and at 52x14, the
 * Termux size with the keyboard open, and bounds what reaches the terminal.
 *
 * Measured on main at 7249cb0c6 (Ink's full repaint), 52x30: 0 clears, 13.5
 * frames/s, 405 rows erased/s, 33 KB/s. Every frame blanked every row and
 * wrote it again. With incremental rendering: 0 rows erased, 3.3 KB/s.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveStreamingModel } from "./streaming-model.js";

const WORDS = Array.from({ length: 120 }, (_, i) => `word${i}`);
// A phone link carries this easily; the full repaint sent ten times as much.
const MAX_BYTES_PER_SEC = 8_000;

async function turn(cols: number, rows: number, env: Record<string, string> = {}) {
	const model = serveStreamingModel(WORDS, 25);
	try {
		const events = await runAppHarness(path.join(import.meta.dir, "flicker.harness.tsx"), {
			...model.env,
			FLICKER_COLS: String(cols),
			FLICKER_ROWS: String(rows),
			"8GENT_REDUCED_MOTION": "0",
			...env,
		});
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const t = events.find((e) => e.phase === "turn") as Record<string, number>;
		console.log(`[flicker] ${cols}x${rows} ${JSON.stringify(env)} ${JSON.stringify(t)}`);
		const screen = (events.find((e) => e.phase === "screen-final")?.rows ?? []) as string[];
		return { t, screen };
	} finally {
		model.stop();
	}
}

for (const [cols, rows] of [
	[52, 30],
	[52, 14],
] as const) {
	test(`streaming turn at ${cols}x${rows}: no clears, no blanked rows, bounded bytes`, async () => {
		const { t } = await turn(cols, rows);
		expect(t.clears).toBe(0);
		expect(t.erasedRows).toBe(0);
		expect(t.frames).toBeGreaterThan(0);
		expect(t.bytesPerSec).toBeLessThan(MAX_BYTES_PER_SEC);
	}, 120_000);
}

// Keyboard open and close mid-turn. Ink clears the screen when the frame it
// last drew is taller than the new terminal (ink.js onRender, the
// lastOutputHeight >= rows branch), once for the stale frame and once for the
// resized one. That is two clears per keyboard open, an event, not a rate;
// this bounds it so it cannot grow into a per-frame clear again.
test("keyboard opening and closing mid-turn clears at most twice", async () => {
	const { t } = await turn(52, 30, { FLICKER_KEYBOARD: "1" });
	// Ink's clearTerminal is ESC[2J ESC[3J ESC[H: two matches per clear.
	expect(t.clears).toBeLessThanOrEqual(4);
	expect(t.erasedRows).toBe(0);
	expect(t.bytesPerSec).toBeLessThan(MAX_BYTES_PER_SEC);
}, 120_000);

// Rewriting only changed rows must leave the same screen as a full repaint.
test("incremental rendering leaves the same screen as Ink's full repaint", async () => {
	const norm = (rows: string[]) =>
		rows.map((r) => r.replace(/\d{1,2}:\d{2}( [AP]M)?/g, "T").replace(/[⠀-⣿]/g, "*"));
	const inc = await turn(52, 30);
	const full = await turn(52, 30, { "8GENT_FULL_REDRAW": "1" });
	expect(full.t.erasedRows).toBeGreaterThan(0);
	expect(inc.screen.join("\n")).toContain("DONE");
	expect(norm(inc.screen)).toEqual(norm(full.screen));
}, 180_000);
