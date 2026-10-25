/**
 * Keys-up layout (#4967): with the soft keyboard open a phone has 14 to 16
 * rows, and the chrome used to leave the answer one. In the real App on a fake
 * TTY: at 52x14 and 40x14 the answer is on screen with the prompt and the
 * footer, nothing is pushed off the bottom, and no frame or brand box is
 * drawn; at 52x30 the full layout is unchanged.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { runAppHarness } from "./app-driver.js";
import { serveFakeModel } from "./fake-model.js";

const REPLY = "Marigold is a terminal coding assistant that runs your tests.";

async function screens(cols: number, rows: number) {
	const model = serveFakeModel(REPLY);
	try {
		const events = await runAppHarness(
			path.join(import.meta.dir, "keys-up.harness.tsx"),
			{
				...model.env,
				FAKE_REPLY: REPLY,
				KEYS_UP_COLS: String(cols),
				KEYS_UP_ROWS: String(rows),
			},
			100_000,
		);
		expect(events.find((e) => e.phase === "error")).toBeUndefined();
		const at = (phase: string) => (events.find((e) => e.phase === phase)?.rows ?? []) as string[];
		return { idle: at("idle"), reply: at("reply") };
	} finally {
		model.stop();
	}
}

const trimmed = (rows: string[]) => {
	const out = rows.map((r) => r.replace(/\s+$/, ""));
	while (out.length && out[out.length - 1] === "") out.pop();
	return out;
};

for (const [cols, rows] of [
	[52, 14],
	[40, 14],
] as const) {
	test(`${cols}x${rows}: the answer stays on screen and nothing is pushed off`, async () => {
		const { reply } = await screens(cols, rows);
		const screen = trimmed(reply);
		const text = screen.join("\n");
		// Nothing pushed off screen: the frame fits the terminal.
		expect(screen.length).toBeLessThanOrEqual(rows);
		for (const row of screen) expect([...row].length).toBeLessThanOrEqual(cols);
		// The answer, from its first words, is visible.
		expect(text).toContain("Marigold is a terminal");
		// The prompt and the footer are kept.
		expect(screen.some((r) => r.includes("❯"))).toBe(true);
		expect(text).toContain("palette");
		// The conversation keeps its rows: between the status row and the prompt.
		const prompt = screen.findIndex((r) => r.includes("❯"));
		expect(prompt - 2).toBeGreaterThanOrEqual(6);
		// No brand box, no frame, no status box: no border corners at all.
		expect(text).not.toMatch(/[┌┐└┘╭╮╰╯]/);
		// No row of rule glued into a sentence.
		for (const row of screen) expect(row).not.toMatch(/─[A-Za-z]|[A-Za-z]─/);
	}, 130_000);
}

test("52x30: the full layout is kept: brand box, frame and status box", async () => {
	const { reply } = await screens(52, 30);
	const screen = trimmed(reply);
	const text = screen.join("\n");
	expect(screen.length).toBeLessThanOrEqual(30);
	expect(text).toContain("8gent Code");
	expect(text).toMatch(/╭/);
	expect(text).toMatch(/┌/);
	expect(text).toContain("Marigold is a terminal");
	expect(text).toContain("palette");
}, 130_000);
