/**
 * The deck says what is playing from the source's own metadata (#3192):
 * track name, every artist, and the key with an honest label. It never
 * shows a placeholder artist, and it fits 80 columns.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box, renderToString } from "ink";
import React from "react";
import { DjRow } from "../DjDeck";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(SGR, "");

function deck(props: Partial<Parameters<typeof DjRow>[0]>, width = 80) {
	const base = {
		paused: false,
		track: "No Agreement (LP)",
		artist: "Fela Kuti",
		elapsed: "0:28",
		duration: "31:05",
		volume: 60,
		keysActive: false,
		showVolume: width >= 110,
		keyLabel: "Key: F minor (est.)",
	};
	return strip(
		renderToString(
			<Box width={width}>
				<DjRow {...base} {...props} />
			</Box>,
			{ columns: width },
		),
	);
}

describe("DjDeck track info (#3192)", () => {
	test("shows the track name, the artist and the key while it plays", () => {
		const f = deck({});
		expect(f).toContain("No Agreement (LP)");
		expect(f).toContain("Fela Kuti");
		expect(f).toContain("Key: F minor (est.)");
	});

	test("every artist is shown where there is room; at 80 columns the list ends in an ellipsis", () => {
		expect(deck({ artist: "Fela Kuti, Roy Ayers" }, 120)).toContain("Fela Kuti, Roy Ayers");
		expect(deck({ artist: "Fela Kuti, Roy Ayers" })).toContain("Fela Kuti…");
	});

	test("while the key is being worked out it says so", () => {
		expect(deck({ keyLabel: "Key: detecting..." })).toContain("Key: detecting...");
	});

	test("fits 80 columns with a long title and many artists, key kept whole", () => {
		const f = deck({
			track:
				"An Extremely Long Track Title That Goes On And On Past Any Reasonable Width (Remastered)",
			artist: "Fela Kuti, Africa 70, Ginger Baker, Roy Ayers, Tony Allen, Lester Bowie",
			keyLabel: "Key: detecting...",
		});
		for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
		expect(f).toContain("Key: detecting...");
		expect(f).toContain("31:05");
	});

	test("the deck never hardcodes an artist placeholder", () => {
		const src = readFileSync(join(import.meta.dir, "..", "DjDeck.tsx"), "utf-8");
		expect(src).not.toContain('"Instrumental"');
	});
});
