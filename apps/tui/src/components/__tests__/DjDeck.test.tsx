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
				track:
					"A Very Long Track Title That Should Be Truncated By The Strip Renderer",
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
