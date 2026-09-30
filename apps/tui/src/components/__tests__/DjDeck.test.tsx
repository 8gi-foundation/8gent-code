/**
 * The compact DJ deck (James, 2026-09-30): one row while a track plays, two
 * while the deck has the keyboard, labelled DJ, with car-stereo key caps that
 * show keys a normal terminal delivers (#3188).
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, render, renderToString } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { DJ_KEYS, DjKeysRow, DjRow, FmFooterSegment, djControl } from "../DjDeck";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(SGR, "");
/** The row's flexible gap collapsed to its two-space minimum. */
const tight = (s: string) => s.replace(/ {3,}/g, "  ");

function frame(node: React.ReactElement, width = 80): string {
	return strip(renderToString(<Box width={width}>{node}</Box>, { columns: width }));
}

const FELA = {
	paused: false,
	track: "No Agreement (LP)",
	artist: "Fela Kuti",
	keyLabel: "Key: F minor (est.)",
	elapsed: "1:15",
	duration: "31:05",
	volume: 60,
	keysActive: false,
};

describe("the DJ row", () => {
	test("one row: DJ, the track, the artist, the key, the clock, the volume and the ^D cap", () => {
		const f = frame(<DjRow {...FELA} />, 160);
		expect(f.split("\n")).toHaveLength(1);
		expect(tight(f)).toBe(
			"DJ ▶ No Agreement (LP)  Fela Kuti  Key: F minor (est.)  1:15 / 31:05  vol 60%  [^D] keys",
		);
		expect(f).not.toContain("8GENT FM");
	});

	test("fits 80 columns with a long title and many artists; the key, clock and cap stay whole", () => {
		const f = frame(
			<DjRow
				{...FELA}
				track="An Extremely Long Track Title That Goes On And On Past Any Reasonable Width (Remastered)"
				artist="Fela Kuti, Africa 70, Ginger Baker, Roy Ayers, Tony Allen"
				showVolume={false}
			/>,
		);
		expect(f.split("\n")).toHaveLength(1);
		expect(stringWidth(f)).toBeLessThanOrEqual(80);
		expect(f).toContain("Key: F minor (est.)");
		expect(f).toContain("1:15 / 31:05  [^D] keys");
	});

	test("at 80 columns Fela Kuti's row keeps the name, the artist and the key whole", () => {
		const f = frame(<DjRow {...FELA} showVolume={false} />);
		expect(tight(f)).toBe(
			"DJ ▶ No Agreement (LP)  Fela Kuti  Key: F minor (est.)  1:15 / 31:05  [^D] keys",
		);
		expect(stringWidth(f)).toBeLessThanOrEqual(80);
	});

	test("paused and muted say so in words, not only in colour", () => {
		const f = frame(<DjRow {...FELA} paused volume={0} />, 160);
		expect(f).toStartWith("DJ ❚❚ ");
		expect(f).toContain("muted");
	});

	test("while the deck has the keyboard the row drops its ^D cap: the caps are on the next row", () => {
		expect(frame(<DjRow {...FELA} keysActive />, 160)).not.toContain("[^D]");
	});

	test("never a placeholder artist", () => {
		expect(frame(<DjRow {...FELA} artist="" />, 160)).toMatch(/^DJ ▶ No Agreement \(LP\) +Key/);
	});
});

describe("the key caps (car stereo)", () => {
	test("show the key and its symbol, in stereo order, and fit 80 columns", () => {
		const f = frame(<DjKeysRow volume={60} />);
		expect(f.trim()).toBe("[B ◀◀] [Space ▶❚] [N ▶▶] [S ■]  [-] [+] vol 60%  [M] mute  [Esc] chat");
		expect(stringWidth(f)).toBeLessThanOrEqual(80);
	});

	test("every cap draws one cell per character: no two-cell emoji transport symbols", () => {
		for (const k of DJ_KEYS) {
			expect(stringWidth(k.cap)).toBe([...k.cap].length);
			expect(k.cap).not.toMatch(/[⏯⏭⏮⏹]/);
		}
	});

	test("the keys are plain keys a normal terminal delivers, and each cap's key does what it says", () => {
		expect(djControl("b")).toBe("prev");
		expect(djControl(" ")).toBe("pause");
		expect(djControl("n")).toBe("next");
		expect(djControl("s")).toBe("stop");
		expect(djControl("-")).toBe("down");
		expect(djControl("+")).toBe("up");
		expect(djControl("=")).toBe("up");
		expect(djControl("m")).toBe("mute");
		expect(djControl("x")).toBeNull();
		expect(djControl(undefined)).toBeNull();
	});

	test("a screen reader hears the controls in words", async () => {
		const out: string[] = [];
		const stdout = Object.assign(new EventEmitter(), {
			columns: 80,
			rows: 10,
			isTTY: false,
			write: (s: string) => {
				out.push(s);
				return true;
			},
		});
		const app = render(<DjKeysRow />, {
			stdout: stdout as unknown as NodeJS.WriteStream,
			isScreenReaderEnabled: true,
			patchConsole: false,
		});
		await new Promise((r) => setTimeout(r, 20));
		app.unmount();
		const spoken = strip(out.join(""));
		expect(spoken).toContain("Space play or pause");
		expect(spoken).toContain("Escape back to chat");
		expect(spoken).not.toContain("▶❚");
	});
});

describe("the footer segment", () => {
	test("reads DJ and the track, the deck's own name and colour (#3238)", () => {
		const dj = frame(<FmFooterSegment width={40} playing track="No Agreement" />, 40);
		expect(dj.trim()).toBe("▶ DJ No Agreement");
		const paused = frame(<FmFooterSegment width={40} playing paused track="" />, 40);
		expect(paused.trim()).toBe("❚❚ DJ");
		expect(dj).not.toContain("8GENT FM");
	});
});
