/**
 * A playing deck costs little and holds still (#3184).
 *
 * The deck used to repaint about six times a second while a track played: a
 * 250 ms pseudo-waveform tick, a 1 s local clock and a 1 s poll, each a full
 * Ink frame, about a quarter of a core. Now its one timer is the 1 s poll,
 * and a poll only renders when what the deck draws changed: the clock moves
 * in 5 s steps. Under reduced motion or NO_COLOR it moves in 15 s steps and
 * nothing else moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box, renderToString } from "ink";
import React from "react";
import { keepIfSame } from "../../lib/keep-if-same";
import { DjRow, type DjStatus, FmFooterSegment, clockStep, deckStill, deckView } from "../DjDeck";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(SGR, "");
const src = readFileSync(join(import.meta.dir, "..", "DjDeck.tsx"), "utf-8");

function poll(position: number): DjStatus {
	return {
		playing: true,
		paused: false,
		looping: false,
		title: "Fela Kuti - No Agreement",
		url: "https://www.youtube.com/watch?v=abc",
		position,
		duration: 1865.04,
		volume: 60,
		queueSize: 0,
		name: "No Agreement",
		artists: ["Fela Kuti"],
		keyLabel: "Key: F minor (est.)",
	};
}

/** How many renders a minute of 1 s polls causes, starting 0.37 s into the track. */
function rendersPerMinute(step: number): number {
	let state: DjStatus | null = null;
	let renders = 0;
	for (let i = 0; i < 60; i++) {
		const next = keepIfSame(deckView(poll(0.37 + i), step))(state as DjStatus);
		if (next !== state) renders++;
		state = next;
	}
	return renders;
}

describe("the playing deck is cheap and still (#3184)", () => {
	test("its only timer is the 1 s poll: no animation tick, no local clock", () => {
		const intervals = [...src.matchAll(/setInterval\([\s\S]*?,\s*(\d+)\)/g)].map((m) =>
			Number(m[1]),
		);
		expect(intervals).toEqual([1000]);
		expect(src).not.toMatch(/waveFrame|miniWaveFrame|setTick/);
	});

	test("a poll renders only when the drawn clock step changes: twelve renders a minute", () => {
		expect(rendersPerMinute(clockStep(false))).toBe(12);
		// Same step, jittered position: no render.
		const a = deckView(poll(10.1), clockStep(false));
		const b = deckView(poll(14.9), clockStep(false));
		expect(keepIfSame(b)(a)).toBe(a);
	});

	test("under reduced motion or NO_COLOR the clock steps every 15 s: four renders a minute", () => {
		expect(deckStill({ "8GENT_REDUCED_MOTION": "1" })).toBe(true);
		expect(deckStill({ NO_COLOR: "1" })).toBe(true);
		expect(deckStill({})).toBe(false);
		expect(rendersPerMinute(clockStep(true))).toBe(4);
	});

	test("the playing deck draws no pseudo-waveform", () => {
		const row = strip(
			renderToString(
				<Box width={80}>
					<DjRow
						paused={false}
						track="No Agreement"
						artist="Fela Kuti"
						elapsed="0:28"
						duration="31:05"
						volume={60}
						keysActive={false}
						keyLabel="Key: F minor (est.)"
					/>
				</Box>,
				{ columns: 80 },
			),
		);
		const seg = strip(
			renderToString(
				<Box width={80}>
					<FmFooterSegment width={22} playing dj track="No Agreement" label="" labelColor="" />
				</Box>,
				{ columns: 80 },
			),
		);
		for (const f of [row, seg]) expect(f).not.toMatch(/[▁▂▃▄▅▆▇█]/);
		expect(row).toContain("0:28 / 31:05");
	});
});
