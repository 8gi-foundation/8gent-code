/**
 * Chunk-and-merge unit tests (VIDEO-INGESTION spec §8). Pure — no sidecar.
 */

import { describe, expect, test } from "bun:test";
import type { VideoEvent } from "../../types.js";
import {
	MAX_CHUNK_SEC,
	jaccard,
	mergeEvents,
	mergeScenes,
	planChunks,
	rebaseEvents,
} from "../chunk-merge.js";

describe("planChunks", () => {
	test("a short video is one window", () => {
		const windows = planChunks(96.4);
		expect(windows).toHaveLength(1);
		expect(windows[0]).toEqual({ index: 0, startSec: 0, endSec: 96.4 });
	});

	test("a video exactly at the cap is one window", () => {
		expect(planChunks(MAX_CHUNK_SEC)).toHaveLength(1);
	});

	test("a long video splits into 120s windows", () => {
		const windows = planChunks(250);
		expect(windows).toHaveLength(3);
		expect(windows[0]).toEqual({ index: 0, startSec: 0, endSec: 120 });
		expect(windows[1]).toEqual({ index: 1, startSec: 120, endSec: 240 });
		expect(windows[2]).toEqual({ index: 2, startSec: 240, endSec: 250 });
	});

	test("a too-short tail window merges into its predecessor", () => {
		// 241s => windows [0-120], [120-240], [240-241]. The 1s tail is under
		// the 2s minimum and merges back.
		const windows = planChunks(241);
		expect(windows).toHaveLength(2);
		expect(windows[1]).toEqual({ index: 1, startSec: 120, endSec: 241 });
	});

	test("zero or negative duration yields no windows", () => {
		expect(planChunks(0)).toHaveLength(0);
		expect(planChunks(-5)).toHaveLength(0);
	});
});

describe("rebaseEvents", () => {
	test("adds the window offset to every timestamp", () => {
		const events: VideoEvent[] = [{ start: 1, end: 5, description: "x" }];
		const rebased = rebaseEvents(events, 120, 250);
		expect(rebased[0].start).toBe(121);
		expect(rebased[0].end).toBe(125);
	});

	test("clamps a timestamp that runs past the clip duration (spec §13)", () => {
		const events: VideoEvent[] = [{ start: 110, end: 130, description: "x" }];
		const rebased = rebaseEvents(events, 120, 245);
		// 120 + 130 = 250 would exceed durationSec 245 => clamped.
		expect(rebased[0].end).toBe(245);
		expect(rebased[0].start).toBe(230);
	});
});

describe("jaccard", () => {
	test("identical descriptions score 1", () => {
		expect(jaccard("a developer types a command", "a developer types a command")).toBe(1);
	});

	test("disjoint descriptions score 0", () => {
		expect(jaccard("cat dog fish", "tree rock cloud")).toBe(0);
	});

	test("punctuation and case are ignored", () => {
		expect(jaccard("Hello, World!", "hello world")).toBe(1);
	});
});

describe("mergeEvents — timestamp rebasing + seam dedup", () => {
	test("non-seam events from two windows are concatenated and sorted", () => {
		const w0 = rebaseEvents([{ start: 0, end: 4, description: "open terminal" }], 0, 250);
		const w1 = rebaseEvents([{ start: 0, end: 4, description: "close terminal" }], 120, 250);
		const merged = mergeEvents([w0, w1], [120]);
		expect(merged).toHaveLength(2);
		expect(merged[0].description).toBe("open terminal");
		expect(merged[1].start).toBe(120);
	});

	test("a duplicate event straddling the seam collapses into one span", () => {
		// Window 0 ends with an event at 118-120; window 1 opens with a
		// near-identical event at 120-122 (window-relative 0-2).
		const w0 = rebaseEvents(
			[
				{ start: 1, end: 5, description: "developer types" },
				{ start: 118, end: 120, description: "scene transition near the boundary" },
			],
			0,
			250,
		);
		const w1 = rebaseEvents(
			[{ start: 0, end: 2, description: "scene transition near the boundary" }],
			120,
			250,
		);
		const merged = mergeEvents([w0, w1], [120]);
		// 3 raw events -> 2 after the seam collapse.
		expect(merged).toHaveLength(2);
		const seam = merged.find((e) => e.description.includes("scene transition"));
		expect(seam).toBeDefined();
		expect(seam?.start).toBe(118);
		expect(seam?.end).toBe(122); // spans both windows
	});

	test("events near a boundary but with unrelated descriptions are NOT merged", () => {
		const w0 = rebaseEvents([{ start: 119, end: 120, description: "a cat sleeps" }], 0, 250);
		const w1 = rebaseEvents([{ start: 0, end: 1, description: "a rocket launches" }], 120, 250);
		const merged = mergeEvents([w0, w1], [120]);
		expect(merged).toHaveLength(2);
	});

	test("events away from the boundary are never seam-merged", () => {
		const w0 = rebaseEvents([{ start: 10, end: 20, description: "same text here" }], 0, 250);
		const w1 = rebaseEvents([{ start: 80, end: 90, description: "same text here" }], 120, 250);
		const merged = mergeEvents([w0, w1], [120]);
		expect(merged).toHaveLength(2);
	});
});

describe("mergeScenes", () => {
	test("concatenates non-empty paragraphs", () => {
		expect(mergeScenes(["First part.", "", "  Second part.  "])).toBe("First part. Second part.");
	});

	test("empty input yields an empty string", () => {
		expect(mergeScenes([])).toBe("");
	});
});
