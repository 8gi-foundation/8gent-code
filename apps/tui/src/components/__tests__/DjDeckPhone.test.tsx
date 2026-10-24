/**
 * The DJ row on a phone (#4907). Termux is about 52 columns; the full row left
 * the title three letters ("Lof…") and the way to stop off the screen.
 */

import { describe, expect, test } from "bun:test";
import { Box, renderToString } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { DjKeysRow, DjRow, NARROW_DECK_COLUMNS } from "../DjDeck";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function frame(node: React.ReactElement, width: number): string {
	return renderToString(<Box width={width}>{node}</Box>, { columns: width }).replace(SGR, "");
}

const BASE = {
	paused: false,
	track: "Lofi beats to relax",
	artist: "Lofi Girl",
	keyLabel: "Key: detecting...",
	elapsed: "0:12",
	duration: "3:20",
	volume: 100,
	keysActive: false,
	showVolume: false,
};

describe("the DJ row at 52 columns", () => {
	test("the full row at 52 columns loses the title (the fault)", () => {
		const f = frame(<DjRow {...BASE} />, 52);
		expect(f).toContain("Lof…");
		expect(f).not.toContain("Lofi beats");
	});

	test("the phone row shows the title, playing, the clock and how to stop", () => {
		const f = frame(<DjRow {...BASE} narrow />, 52);
		expect(f.split("\n")).toHaveLength(1);
		expect(stringWidth(f)).toBeLessThanOrEqual(52);
		expect(f).toContain("DJ ▶ Lofi beats to relax");
		expect(f).toContain("playing 0:12");
		expect(f).toContain("/dj stop");
	});

	test("paused says paused, in words and in the glyph", () => {
		const f = frame(<DjRow {...BASE} narrow paused />, 52);
		expect(f).toContain("DJ ❚❚ ");
		expect(f).toContain("paused 0:12");
		expect(f).not.toContain("playing");
	});

	test("a long title truncates; the state and the stop stay whole", () => {
		const f = frame(
			<DjRow
				{...BASE}
				narrow
				track="An Extremely Long Track Title That Goes On And On (Remastered)"
			/>,
			52,
		);
		expect(stringWidth(f)).toBeLessThanOrEqual(52);
		expect(f).toContain("…");
		expect(f).toContain("playing 0:12  /dj stop");
	});

	test("while the deck has the keyboard the keys row carries stop and the row drops the hint", () => {
		const row = frame(<DjRow {...BASE} narrow keysActive />, 52);
		expect(row).not.toContain("/dj stop");
		const keys = frame(<DjKeysRow narrow />, 52);
		expect(stringWidth(keys)).toBeLessThanOrEqual(52);
		expect(keys).toContain("S ■");
		expect(keys).toContain("Space ▶❚");
		expect(keys).toContain("Esc");
	});

	test("the wide keys row does not fit 52 columns, which is why the narrow one exists", () => {
		expect(stringWidth(frame(<DjKeysRow volume={100} />, 200).trimEnd())).toBeGreaterThan(52);
	});

	test("the phone threshold sits below the 80-column layout", () => {
		expect(NARROW_DECK_COLUMNS).toBeGreaterThan(52);
		expect(NARROW_DECK_COLUMNS).toBeLessThanOrEqual(80);
	});
});

describe("the row when the player says nothing is heard (#4907)", () => {
	const TROUBLE = "no sound output: [ao] Failed to initialize audio driver 'opensles'";
	test("wide: no sound and the reason, never playing", () => {
		const f = frame(<DjRow {...BASE} trouble={TROUBLE} />, 120);
		expect(f).toContain("✕");
		expect(f).toContain("no sound output");
		expect(f).not.toContain("▶");
	});
	test("phone width: the reason replaces the title and fits 52 columns", () => {
		const f = frame(<DjRow {...BASE} narrow trouble={TROUBLE} />, 52);
		expect(stringWidth(f)).toBeLessThanOrEqual(52);
		expect(f).toContain("✕");
		expect(f).toContain("no sound output");
		expect(f).not.toContain("playing");
	});
});
