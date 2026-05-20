/**
 * `extract_video` handler tests against the fake Marlin sidecar.
 *
 * Covers: VideoExtraction assembly, chunk-and-merge on a >2min video,
 * capability-off error, sidecar-crash restart-and-retry, no-audio handling,
 * path/sniff rejection, and the `query` find path (VIDEO-INGESTION spec §6-8).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtractVideoDeps, extractVideo } from "../extract-video.js";
import type { SidecarSpawnSpec } from "../jsonrpc-client.js";
import { type VideoFixtures, makeVideoFixtures } from "./fixtures.js";

const FAKE = join(import.meta.dir, "fake-sidecar.ts");

let fx: VideoFixtures;
let SAMPLE_MP4: string;
let NOT_VIDEO: string;
let FIXTURES: string;
beforeAll(() => {
	fx = makeVideoFixtures();
	SAMPLE_MP4 = fx.sampleMp4;
	NOT_VIDEO = fx.notVideo;
	FIXTURES = fx.dir;
});
afterAll(() => {
	rmSync(fx.dir, { recursive: true, force: true });
});

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(mode: string, extraEnv: Record<string, string> = {}): ExtractVideoDeps {
	const spawnSpec: SidecarSpawnSpec = {
		command: "bun",
		args: ["run", FAKE],
		env: { FAKE_MODE: mode, ...extraEnv },
	};
	return { spawnSpec, skipCapabilityCheck: true };
}

describe("extractVideo — capability gate", () => {
	test("returns a structured install-required error when not installed", async () => {
		// No skipCapabilityCheck and no env override => the gate fires.
		const result = await extractVideo(
			{ path: SAMPLE_MP4 },
			{ spawnSpec: { command: "bun", args: ["run", FAKE], env: { FAKE_MODE: "ok" } } },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("capability_not_installed");
			expect(result.error.suggestion).toBe("8gent vision install");
		}
	});
});

describe("extractVideo — path and container validation", () => {
	test("rejects a missing file", async () => {
		const result = await extractVideo({ path: join(FIXTURES, "missing.mp4") }, deps("ok"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("invalid_path");
	});

	test("rejects a non-video file by container sniff", async () => {
		const result = await extractVideo({ path: NOT_VIDEO }, deps("ok"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_a_video");
	});
});

describe("extractVideo — VideoExtraction assembly", () => {
	test("assembles a full extraction for a short video", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4 }, deps("ok"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const e = result.extraction;
		expect(e.path).toContain("sample.mp4");
		expect(e.videoId).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(e.durationSec).toBe(96.4);
		expect(e.chunked).toBe(false);
		expect(e.chunkCount).toBe(1);
		expect(e.scene.length).toBeGreaterThan(0);
		expect(e.events).toHaveLength(2);
		expect(e.transcript).toHaveLength(2);
		expect(e.models.vision).toContain("Marlin-2B");
		expect(e.generatedAt).toBeGreaterThan(0);
		// Events and transcript are sorted by start time.
		expect(e.events[0].start).toBeLessThanOrEqual(e.events[1].start);
	});

	test("visual mode produces events but no transcript", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4, mode: "visual" }, deps("ok"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.events.length).toBeGreaterThan(0);
		expect(result.extraction.transcript).toHaveLength(0);
	});

	test("audio mode produces a transcript but no events", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4, mode: "audio" }, deps("ok"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.transcript.length).toBeGreaterThan(0);
		expect(result.extraction.events).toHaveLength(0);
	});

	test("a query runs find and records the located span", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4, query: "the plan renders" }, deps("ok"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.find).toBeDefined();
		expect(result.extraction.find?.span).toEqual({ start: 14.3, end: 18.2 });
		expect(result.extraction.find?.formatOk).toBe(true);
	});

	test("no audio track yields an empty transcript, visual still succeeds", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4 }, deps("no-audio"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.extraction.transcript).toHaveLength(0);
		expect(result.extraction.events.length).toBeGreaterThan(0);
	});
});

describe("extractVideo — chunk-and-merge (>2min video)", () => {
	test("chunks a 250s video into 3 windows, rebases and seam-dedups", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4 }, deps("long"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const e = result.extraction;
		expect(e.durationSec).toBe(250);
		expect(e.chunked).toBe(true);
		expect(e.chunkCount).toBe(3);

		// Each window emits 3 window-relative events (9 raw): an opening and a
		// closing "scene transition", plus one "developer" event. The
		// developer event sits at window-relative 5s, so it rebases to ~5s in
		// window 0 and ~245s in window 2.
		const developerEvents = e.events.filter((ev) => ev.description.includes("developer"));
		expect(developerEvents.length).toBe(3);
		expect(developerEvents[0].start).toBeCloseTo(5.0, 1);
		expect(developerEvents[2].start).toBeCloseTo(245.0, 1);

		// Seam dedup: each window's CLOSING transition (ends near a boundary)
		// and the next window's OPENING transition (starts near the same
		// boundary) have identical descriptions, so they collapse. 6 raw
		// transition events across 3 windows merge down to 4: window 0's open
		// (0-2), the merged 0/1 seam (118-122), the merged 1/2 seam
		// (238-242), and window 2's close clamped to duration (250-250).
		const seamEvents = e.events.filter((ev) => ev.description.includes("scene transition"));
		expect(seamEvents.length).toBe(4);
		// A merged seam event spans across a window boundary.
		expect(seamEvents.some((ev) => ev.start < 120 && ev.end > 120)).toBe(true);
		expect(seamEvents.some((ev) => ev.start < 240 && ev.end > 240)).toBe(true);

		// All event timestamps are within the clip duration.
		for (const ev of e.events) {
			expect(ev.end).toBeLessThanOrEqual(e.durationSec);
		}
		// Events are globally sorted by start.
		for (let i = 1; i < e.events.length; i++) {
			expect(e.events[i].start).toBeGreaterThanOrEqual(e.events[i - 1].start);
		}
	});
});

describe("extractVideo — sidecar crash retry", () => {
	test("restarts the sidecar once after a crash and the retry succeeds", async () => {
		const flagDir = mkdtempSync(join(tmpdir(), "marlin-crash-"));
		tempDirs.push(flagDir);
		const crashFlag = join(flagDir, "crashed.flag");
		const progress: string[] = [];
		const d = deps("crash-once", { FAKE_CRASH_FLAG: crashFlag });
		d.onProgress = (m) => progress.push(m);

		const result = await extractVideo({ path: SAMPLE_MP4 }, d);
		// First spawn crashes on `caption`; the handler restarts once and the
		// second spawn (flag present) behaves as `ok`.
		expect(result.ok).toBe(true);
		expect(progress.some((m) => m.includes("restarting"))).toBe(true);
	});

	test("a second crash returns a structured sidecar_failure with stderr tail", async () => {
		// No crash flag => every spawn crashes; the handler gives up after one
		// retry and returns the error.
		const result = await extractVideo({ path: SAMPLE_MP4 }, deps("crash-once"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("sidecar_failure");
			expect(result.error.stderrTail).toContain("simulated crash");
		}
	});

	test("a JSON-RPC decode error maps to a decode_failure with a re-encode hint", async () => {
		const result = await extractVideo({ path: SAMPLE_MP4 }, deps("rpc-error"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("decode_failure");
			expect(result.error.suggestion).toContain("H.264");
		}
	});
});

describe("extractVideo — ingest handoff", () => {
	test("ingest:true calls the injected ingest hook and surfaces its result", async () => {
		const progress: string[] = [];
		const d = deps("ok");
		d.onProgress = (m) => progress.push(m);
		let hookSawVideoId = "";
		d.ingestHook = (extraction) => {
			hookSawVideoId = extraction.videoId;
			return {
				videoId: extraction.videoId,
				entitiesCreated: 5,
				relationshipsCreated: 4,
				stage2Ran: false,
			};
		};

		const result = await extractVideo({ path: SAMPLE_MP4, ingest: true }, d);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// The hook received the same VideoExtraction the tool assembled.
			expect(hookSawVideoId).toBe(result.extraction.videoId);
			expect(result.ingest).toBeDefined();
			expect(result.ingest?.entitiesCreated).toBe(5);
			expect(result.ingest?.relationshipsCreated).toBe(4);
		}
		expect(progress.some((m) => m.includes("knowledge graph"))).toBe(true);
	});

	test("ingest:false does not invoke the ingest hook", async () => {
		const d = deps("ok");
		let hookCalled = false;
		d.ingestHook = (extraction) => {
			hookCalled = true;
			return {
				videoId: extraction.videoId,
				entitiesCreated: 0,
				relationshipsCreated: 0,
				stage2Ran: false,
			};
		};
		const result = await extractVideo({ path: SAMPLE_MP4 }, d);
		expect(result.ok).toBe(true);
		expect(hookCalled).toBe(false);
		if (result.ok) expect(result.ingest).toBeUndefined();
	});
});
