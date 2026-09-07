/**
 * DjDeck snapshot tests (#2341).
 *
 * The stateful DjDeck component drives audio polling and useInput, so we
 * cover the two render shapes via the pure render helpers it exports:
 *   - StereoDisplay         (expanded, three-row stereo)
 *   - CollapsedDjDeckStrip  (single-line strip, height 1)
 *
 * Pattern mirrors HeaderBar.test.tsx: shallow render, snapshot stable
 * top-level structural props.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";
import { CollapsedDjDeckStrip, StereoDisplay } from "../DjDeck";

function shallow<T>(node: React.ReactElement): T {
	return node.props as T;
}

describe("DjDeck — collapsed strip", () => {
	test("renders a single-line strip with height 1", () => {
		const el = CollapsedDjDeckStrip({
			playing: true,
			track: "Lazer Dim 700 — Lottery",
			tick: 3,
		});
		const props = shallow<{ width: string; height: number; flexShrink: number }>(el);
		expect(props.width).toBe("100%");
		expect(props.height).toBe(1);
		expect(props.flexShrink).toBe(0);
	});

	test("renders idle placeholder when no track", () => {
		const el = CollapsedDjDeckStrip({ playing: false, track: "", tick: 0 });
		expect(el).toBeDefined();
		const props = shallow<{ height: number }>(el);
		// Even with no track the strip stays in chrome.
		expect(props.height).toBe(1);
	});

	test("matrix snapshot across playing / track-length / tick", () => {
		const matrix = [
			{ playing: true, track: "Short", tick: 0 },
			{ playing: true, track: "Short", tick: 7 },
			{ playing: false, track: "Short", tick: 0 },
			{
				playing: true,
				track: "A Very Long Track Title That Should Be Truncated By The Strip Renderer",
				tick: 12,
			},
			{ playing: false, track: "", tick: 0 },
		].map((cfg, idx) => {
			const el = CollapsedDjDeckStrip(cfg);
			const top = shallow<{ width: string; height: number; flexShrink: number }>(el);
			return {
				idx,
				width: top.width,
				height: top.height,
				flexShrink: top.flexShrink,
				playing: cfg.playing,
				trackLen: cfg.track.length,
			};
		});
		expect(matrix).toMatchSnapshot();
	});
});

describe("DjDeck — expanded stereo", () => {
	test("renders a bordered three-row column", () => {
		const el = StereoDisplay({
			playing: true,
			track: "8gent FM",
			artist: "Instrumental",
			elapsed: "0:14",
			duration: "3:21",
			volume: 50,
			muted: false,
			tick: 4,
			termWidth: 80,
		});
		const props = shallow<{
			width: string;
			borderStyle: string;
			flexDirection: string;
		}>(el);
		expect(props.width).toBe("100%");
		expect(props.borderStyle).toBe("single");
		expect(props.flexDirection).toBe("column");
	});

	test("matrix snapshot across playing / muted / volume", () => {
		const base = {
			track: "8gent FM",
			artist: "Instrumental",
			elapsed: "0:00",
			duration: "0:00",
			tick: 0,
			termWidth: 80,
		};
		const matrix = [
			{ ...base, playing: false, volume: 50, muted: false },
			{ ...base, playing: true, volume: 50, muted: false },
			{ ...base, playing: true, volume: 0, muted: true },
			{ ...base, playing: true, volume: 120, muted: false },
		].map((cfg, idx) => {
			const el = StereoDisplay(cfg);
			const top = shallow<{
				width: string;
				borderStyle: string;
				flexDirection: string;
			}>(el);
			return {
				idx,
				width: top.width,
				borderStyle: top.borderStyle,
				flexDirection: top.flexDirection,
				playing: cfg.playing,
				muted: cfg.muted,
				volume: cfg.volume,
			};
		});
		expect(matrix).toMatchSnapshot();
	});

	test("renders no-track state distinct from loading (#2365)", () => {
		// hasTrack=false: dim placeholder, no artist, idle waveform, volume meter still visible
		const el = StereoDisplay({
			playing: false,
			track: "",
			artist: "",
			elapsed: "0:00",
			duration: "0:00",
			volume: 50,
			muted: false,
			tick: 0,
			termWidth: 80,
			hasTrack: false,
		});
		const props = shallow<{
			width: string;
			borderStyle: string;
			flexDirection: string;
			children: React.ReactNode;
		}>(el);
		// Stereo stays in chrome — same shell as loaded state.
		expect(props.width).toBe("100%");
		expect(props.borderStyle).toBe("single");
		expect(props.flexDirection).toBe("column");
		// Three rows still rendered (track row, artist/wave/time row, volume row).
		const rows = React.Children.toArray(props.children);
		expect(rows.length).toBe(3);
	});

	test("hasTrack defaults to true for backwards compatibility", () => {
		// Existing call sites that don't pass hasTrack should still render the
		// loaded-state stereo (no regression of #2341 always-on chrome).
		const el = StereoDisplay({
			playing: true,
			track: "Some Track",
			artist: "Instrumental",
			elapsed: "0:14",
			duration: "3:21",
			volume: 50,
			muted: false,
			tick: 4,
			termWidth: 80,
		});
		expect(el).toBeDefined();
	});
});

// ---- Headless render smoke (#2934, part of #2922) --------------------------
// The shallow tests above check the top-level Box props. These render the real
// strip and stereo through Ink's reconciler into a fake 80-column stdout and
// assert the visible text, so a change that breaks what the 8GENT FM strip
// shows (not only its outer Box) fails here. Headless harness written for
// this repo (no ink-testing-library dependency), same shape as
// OrchestratorPane.test.tsx.

class FakeStdout extends EventEmitter {
	columns = 80;
	rows = 24;
	isTTY = true;
	frames: string[] = [];
	write = (frame: string): boolean => {
		this.frames.push(frame);
		return true;
	};
	lastFrame(): string {
		return this.frames.at(-1) ?? "";
	}
}

class FakeStdin extends EventEmitter {
	isTTY = false;
	setEncoding(): this {
		return this;
	}
	setRawMode(): this {
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	read(): null {
		return null;
	}
}

/** Strip ANSI colour codes so assertions read the visible text. */
function plain(frame: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte
	return frame.replace(/\[[0-9;]*m/g, "");
}

async function renderFrame(element: React.ReactElement): Promise<string> {
	const stdout = new FakeStdout();
	const stdin = new FakeStdin();
	const instance = render(element, {
		// Structural fakes stand in for the real streams in headless tests.
		stdout: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await new Promise((r) => setTimeout(r, 20));
	const frame = plain(stdout.lastFrame());
	instance.unmount();
	return frame;
}

const lines = (frame: string) => frame.replace(/\s+$/, "").split("\n");

describe("DjDeck collapsed strip renders (headless)", () => {
	test("idle strip is one line: stop glyph, 8GENT FM idle, flat wave, idle clock", async () => {
		const frame = await renderFrame(<CollapsedDjDeckStrip playing={false} track="" tick={0} />);
		expect(lines(frame)).toHaveLength(1);
		expect(frame).toContain("■ 8GENT FM idle");
		expect(frame).toContain("▁▁▁▁");
		expect(frame.trimEnd().endsWith("○")).toBe(true);
	});

	test("playing strip shows the track, an animated wave and the playing clock", async () => {
		const frame = await renderFrame(
			<CollapsedDjDeckStrip playing={true} track="Lazer Dim 700 - Lottery" tick={3} />,
		);
		expect(lines(frame)).toHaveLength(1);
		expect(frame).toContain("▶ Lazer Dim 700 - Lottery");
		expect(frame).not.toContain("8GENT FM idle");
		const wave = frame.match(/[▁▂▃▄▅▆▇█]{4}/)?.[0];
		expect(wave).toBeDefined();
		expect(wave).not.toBe("▁▁▁▁");
		expect(frame.trimEnd().endsWith("◷")).toBe(true);
	});

	test("a long title is truncated inside 80 columns instead of wrapping", async () => {
		const long =
			"A Very Long Track Title That Should Be Truncated By The Strip Renderer And Then Some";
		const frame = await renderFrame(<CollapsedDjDeckStrip playing={true} track={long} tick={0} />);
		const [row] = lines(frame);
		expect(lines(frame)).toHaveLength(1);
		expect([...row].length).toBeLessThanOrEqual(80);
		// The tail of the title is cut, the wave and play clock stay visible.
		expect(row).not.toContain("And Then Some");
		expect(row.trimEnd().endsWith("◷")).toBe(true);
	});
});

describe("DjDeck expanded stereo renders (headless)", () => {
	const playing = {
		playing: true,
		track: "8gent FM",
		artist: "Instrumental",
		elapsed: "0:14",
		duration: "3:21",
		volume: 50,
		muted: false,
		tick: 4,
		termWidth: 80,
	};

	test("shows track, artist, clock, waveform and a half-full volume slider", async () => {
		const frame = await renderFrame(<StereoDisplay {...playing} />);
		const rows = lines(frame);
		// Border top, three rows, border bottom.
		expect(rows).toHaveLength(5);
		expect(rows[0].startsWith("┌")).toBe(true);
		expect(rows[4].startsWith("└")).toBe(true);
		expect(frame).toContain("◴ 8gent FM");
		expect(frame).toContain("◷");
		expect(frame).toContain("Instrumental");
		expect(frame).toContain("0:14 / 3:21");
		// Slider width is 30% of 80 columns = 24 cells; 50% fills 12 of them.
		expect(frame).toContain(`${"█".repeat(12)}${"░".repeat(12)} 50%`);
	});

	test("muted replaces the slider with the word muted", async () => {
		const frame = await renderFrame(<StereoDisplay {...playing} volume={0} muted={true} />);
		expect(frame).toContain("muted");
		expect(frame).not.toContain("%");
	});

	test("volume above 100 fills the slider and keeps the real percentage", async () => {
		const frame = await renderFrame(<StereoDisplay {...playing} volume={120} />);
		expect(frame).toContain(`${"█".repeat(24)} 120%`);
	});

	test("no-track state names the gap and keeps the volume row", async () => {
		const frame = await renderFrame(
			<StereoDisplay
				{...playing}
				playing={false}
				track=""
				artist=""
				elapsed="0:00"
				duration="0:00"
				hasTrack={false}
			/>,
		);
		expect(frame).toContain("○ (no track)");
		expect(frame).toContain("▁▁▁▁▁▁▁▁▁▁▁▁");
		expect(frame).toContain("0:00 / 0:00");
		expect(frame).toContain("50%");
		expect(frame).not.toContain("Instrumental");
	});
});
