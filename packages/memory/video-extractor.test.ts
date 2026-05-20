/**
 * Tests for video-extractor — knowledge-graph ingestion for video
 * (VIDEO-INGESTION spec 9).
 *
 * What is tested (deterministic plumbing + fusion, per the honest constraints):
 *  1. intervalsOverlap — interval-intersection math.
 *  2. fuseTimeline — overlapping event+segment fuse; non-overlapping stay alone;
 *     every event and segment appears exactly once; modality tagging.
 *  3. extractFromVideo without stage-2 — emits the video entity, one event per
 *     fused unit, occurs_in, and precedes in timeline order.
 *  4. Provenance metadata — source/videoId/start/end/modality on every
 *     emitted node.
 *  5. Stage-2 with a MOCK LLM returning fixed triples — content entities,
 *     mentions edges, prompt-version stamp; a throwing mock is non-fatal.
 *  6. videoId dedup — re-ingesting the same videoId upserts the video node,
 *     does not duplicate it, and bumps mention_count.
 *
 * What is NOT tested: the extraction QUALITY of a real LLM. Stage-2 is mocked.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { TranscriptSegment, VideoEvent, VideoExtraction } from "@8gent/eyes";
import { KnowledgeGraph } from "./graph.js";
import {
	type VideoTripleExtractorFn,
	extractFromVideo,
	fuseTimeline,
	ingestVideoToGraph,
	intervalsOverlap,
} from "./video-extractor.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeExtraction(overrides: Partial<VideoExtraction> = {}): VideoExtraction {
	return {
		videoId: "sha256:abc123",
		path: "/Users/j/recordings/demo.mp4",
		durationSec: 30,
		chunked: false,
		chunkCount: 1,
		scene: "A developer demonstrates the plan rail.",
		events: [
			{ start: 0, end: 5, description: "The terminal opens." },
			{ start: 5, end: 12, description: "A plan renders as a checklist." },
		],
		transcript: [
			{ start: 1, end: 4, text: "Let me show you the plan rail." },
			{ start: 20, end: 24, text: "And here is the summary." },
		],
		models: { vision: "NemoStation/Marlin-2B@abc", audio: "whisper-base-mlx" },
		generatedAt: 1747772693000,
		...overrides,
	};
}

const TEST_DB = "/tmp/test-video-extractor-2633.db";

// ── 1. intervalsOverlap ───────────────────────────────────────────────

describe("intervalsOverlap", () => {
	it("returns true for intersecting intervals", () => {
		expect(intervalsOverlap(0, 5, 3, 8)).toBe(true);
		expect(intervalsOverlap(3, 8, 0, 5)).toBe(true);
		expect(intervalsOverlap(0, 10, 2, 4)).toBe(true);
	});

	it("returns false for disjoint intervals", () => {
		expect(intervalsOverlap(0, 5, 5, 8)).toBe(false); // touching, not overlapping
		expect(intervalsOverlap(0, 5, 6, 8)).toBe(false);
		expect(intervalsOverlap(10, 12, 0, 5)).toBe(false);
	});
});

// ── 2. fuseTimeline ───────────────────────────────────────────────────

describe("fuseTimeline", () => {
	it("fuses an overlapping event and transcript segment into one fused unit", () => {
		const events: VideoEvent[] = [{ start: 0, end: 5, description: "term opens" }];
		const transcript: TranscriptSegment[] = [{ start: 1, end: 4, text: "the plan rail" }];
		const units = fuseTimeline(events, transcript);

		expect(units).toHaveLength(1);
		expect(units[0].modality).toBe("fused");
		expect(units[0].event?.description).toBe("term opens");
		expect(units[0].segment?.text).toBe("the plan rail");
		expect(units[0].start).toBe(0);
		expect(units[0].end).toBe(5);
	});

	it("keeps a non-overlapping event and segment as separate lone units", () => {
		const events: VideoEvent[] = [{ start: 0, end: 5, description: "term opens" }];
		const transcript: TranscriptSegment[] = [{ start: 10, end: 14, text: "later speech" }];
		const units = fuseTimeline(events, transcript);

		expect(units).toHaveLength(2);
		expect(units[0].modality).toBe("visual");
		expect(units[1].modality).toBe("audio");
	});

	it("every event and segment appears exactly once", () => {
		const ex = makeExtraction();
		const units = fuseTimeline(ex.events, ex.transcript);

		const seenEvents = units.filter((u) => u.event).length;
		const seenSegments = units.filter((u) => u.segment).length;
		expect(seenEvents).toBe(ex.events.length);
		expect(seenSegments).toBe(ex.transcript.length);
	});

	it("returns units in timeline (start-time) order", () => {
		const ex = makeExtraction();
		const units = fuseTimeline(ex.events, ex.transcript);
		for (let i = 0; i < units.length - 1; i++) {
			expect(units[i].start).toBeLessThanOrEqual(units[i + 1].start);
		}
	});

	it("an event fuses with the first not-yet-consumed overlapping segment", () => {
		// Two segments both overlap the event; only the first fuses.
		const events: VideoEvent[] = [{ start: 0, end: 10, description: "long event" }];
		const transcript: TranscriptSegment[] = [
			{ start: 1, end: 3, text: "first" },
			{ start: 4, end: 6, text: "second" },
		];
		const units = fuseTimeline(events, transcript);
		expect(units).toHaveLength(2);
		const fused = units.find((u) => u.modality === "fused");
		const lone = units.find((u) => u.modality === "audio");
		expect(fused?.segment?.text).toBe("first");
		expect(lone?.segment?.text).toBe("second");
	});
});

// ── 3 + 4. extractFromVideo without stage-2 + provenance ──────────────

describe("extractFromVideo (no stage-2)", () => {
	it("emits exactly one video entity keyed by videoId", async () => {
		const result = await extractFromVideo(makeExtraction());
		const videos = result.entities.filter((e) => e.type === "video");
		expect(videos).toHaveLength(1);
		expect(videos[0].name).toBe("sha256:abc123");
	});

	it("emits one event entity per fused unit", async () => {
		const ex = makeExtraction();
		const units = fuseTimeline(ex.events, ex.transcript);
		const result = await extractFromVideo(ex);
		const events = result.entities.filter((e) => e.type === "event");
		expect(events).toHaveLength(units.length);
	});

	it("emits an occurs_in edge from each event to the video", async () => {
		const result = await extractFromVideo(makeExtraction());
		const occursIn = result.relationships.filter((r) => r.type === "occurs_in");
		const eventCount = result.entities.filter((e) => e.type === "event").length;
		expect(occursIn).toHaveLength(eventCount);
		for (const r of occursIn) {
			expect(r.fromType).toBe("event");
			expect(r.toType).toBe("video");
			expect(r.toName).toBe("sha256:abc123");
		}
	});

	it("emits precedes edges in timeline order, one fewer than the event count", async () => {
		const result = await extractFromVideo(makeExtraction());
		const events = result.entities.filter((e) => e.type === "event");
		const precedes = result.relationships.filter((r) => r.type === "precedes");
		expect(precedes).toHaveLength(events.length - 1);
		// Each precedes edge links consecutive event entities.
		const eventNames = events.map((e) => e.name);
		for (let i = 0; i < precedes.length; i++) {
			expect(precedes[i].fromName).toBe(eventNames[i]);
			expect(precedes[i].toName).toBe(eventNames[i + 1]);
		}
	});

	it("stamps provenance metadata on every event entity", async () => {
		const result = await extractFromVideo(makeExtraction());
		const events = result.entities.filter((e) => e.type === "event");
		for (const e of events) {
			const m = e.metadata as Record<string, unknown>;
			expect(m.source).toBe("video");
			expect(m.videoId).toBe("sha256:abc123");
			expect(typeof m.start).toBe("number");
			expect(typeof m.end).toBe("number");
			expect(["visual", "audio", "fused"]).toContain(m.modality);
		}
	});

	it("tags modality correctly: fused for an overlapping pair, audio for a lone segment", async () => {
		const result = await extractFromVideo(makeExtraction());
		const events = result.entities.filter((e) => e.type === "event");
		const modalities = events.map((e) => (e.metadata as Record<string, unknown>).modality);
		// demo.mp4: event 0-5 overlaps segment 1-4 -> fused; event 5-12 alone -> visual;
		// segment 20-24 alone -> audio.
		expect(modalities).toContain("fused");
		expect(modalities).toContain("visual");
		expect(modalities).toContain("audio");
	});

	it("does not emit content entities or mentions edges when stage-2 is absent", async () => {
		const result = await extractFromVideo(makeExtraction());
		expect(result.relationships.some((r) => r.type === "mentions")).toBe(false);
		const nonTimelineTypes = result.entities.filter(
			(e) => e.type !== "video" && e.type !== "event",
		);
		expect(nonTimelineTypes).toHaveLength(0);
	});
});

// ── 5. Stage-2 with a mock LLM ────────────────────────────────────────

describe("extractFromVideo (stage-2, mock LLM)", () => {
	const fixedTriples: VideoTripleExtractorFn = async () =>
		JSON.stringify({
			entities: [
				{ type: "concept", name: "plan rail", description: "a UI concept" },
				{ type: "tool", name: "8gent", description: "the agent" },
			],
			relationships: [
				{
					fromName: "8gent",
					fromType: "tool",
					toName: "plan rail",
					toType: "concept",
					type: "uses",
				},
			],
		});

	it("emits the mock's content entities with provenance + prompt version", async () => {
		const result = await extractFromVideo(makeExtraction(), {
			extractTriples: fixedTriples,
		});
		const concepts = result.entities.filter((e) => e.type === "concept");
		const tools = result.entities.filter((e) => e.type === "tool");
		expect(concepts.length).toBeGreaterThan(0);
		expect(tools.length).toBeGreaterThan(0);
		for (const e of [...concepts, ...tools]) {
			const m = e.metadata as Record<string, unknown>;
			expect(m.source).toBe("video");
			expect(m.promptVersion).toBe("1.0.0");
		}
	});

	it("emits mentions edges from events to the mock's content entities", async () => {
		const result = await extractFromVideo(makeExtraction(), {
			extractTriples: fixedTriples,
		});
		const mentions = result.relationships.filter((r) => r.type === "mentions");
		expect(mentions.length).toBeGreaterThan(0);
		for (const r of mentions) {
			expect(r.fromType).toBe("event");
		}
	});

	it("passes the mock's own relationships through (uses edge survives)", async () => {
		const result = await extractFromVideo(makeExtraction(), {
			extractTriples: fixedTriples,
		});
		expect(result.relationships.some((r) => r.type === "uses")).toBe(true);
	});

	it("a throwing stage-2 mock is non-fatal: timeline triples still emitted", async () => {
		const throwing: VideoTripleExtractorFn = async () => {
			throw new Error("model unavailable");
		};
		const result = await extractFromVideo(makeExtraction(), { extractTriples: throwing });
		expect(result.entities.filter((e) => e.type === "video")).toHaveLength(1);
		expect(result.entities.filter((e) => e.type === "event").length).toBeGreaterThan(0);
		expect(result.relationships.filter((r) => r.type === "occurs_in").length).toBeGreaterThan(0);
	});

	it("off-schema stage-2 output is dropped, not crashed on", async () => {
		const garbage: VideoTripleExtractorFn = async () => "not json at all {{{";
		const result = await extractFromVideo(makeExtraction(), { extractTriples: garbage });
		// No content entities, but timeline triples intact.
		expect(result.entities.filter((e) => e.type === "concept")).toHaveLength(0);
		expect(result.entities.filter((e) => e.type === "video")).toHaveLength(1);
	});

	it("rejects entities with a disallowed type", async () => {
		const badType: VideoTripleExtractorFn = async () =>
			JSON.stringify({
				entities: [
					{ type: "video", name: "should be rejected" },
					{ type: "concept", name: "kept" },
				],
				relationships: [],
			});
		const result = await extractFromVideo(makeExtraction(), { extractTriples: badType });
		const concepts = result.entities.filter((e) => e.type === "concept");
		expect(concepts.some((e) => e.name === "kept")).toBe(true);
		// "video" content entity from the model is dropped; only the one
		// timeline video entity remains.
		expect(result.entities.filter((e) => e.type === "video")).toHaveLength(1);
	});
});

// ── 6. End-to-end ingest + videoId dedup ──────────────────────────────

describe("ingestVideoToGraph", () => {
	let db: Database;
	let graph: KnowledgeGraph;

	beforeEach(() => {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
		db = new Database(TEST_DB, { create: true });
		graph = new KnowledgeGraph(db);
	});

	afterEach(() => {
		db.close();
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	});

	it("writes the video, events, and edges into the graph", async () => {
		const res = await ingestVideoToGraph(graph, makeExtraction());
		expect(res.videoId).toBe("sha256:abc123");
		expect(res.entitiesCreated).toBeGreaterThan(0);
		expect(res.relationshipsCreated).toBeGreaterThan(0);
		expect(res.stage2Ran).toBe(false);

		const videos = graph.findEntities({ type: "video" });
		expect(videos).toHaveLength(1);
		const events = graph.findEntities({ type: "event" });
		expect(events.length).toBeGreaterThan(0);
	});

	it("re-ingesting the same videoId upserts the video node, not duplicates it", async () => {
		await ingestVideoToGraph(graph, makeExtraction());
		await ingestVideoToGraph(graph, makeExtraction());

		const videos = graph.findEntities({ type: "video" });
		expect(videos).toHaveLength(1);
		// mention_count bumped by the second upsert.
		expect(videos[0].mentionCount).toBe(2);
	});

	it("a different videoId creates a separate video node", async () => {
		await ingestVideoToGraph(graph, makeExtraction());
		await ingestVideoToGraph(graph, makeExtraction({ videoId: "sha256:different" }));
		expect(graph.findEntities({ type: "video" })).toHaveLength(2);
	});

	it("stage-2 ingest reports stage2Ran true and writes content entities", async () => {
		const mock: VideoTripleExtractorFn = async () =>
			JSON.stringify({
				entities: [{ type: "concept", name: "plan rail" }],
				relationships: [],
			});
		const res = await ingestVideoToGraph(graph, makeExtraction(), { extractTriples: mock });
		expect(res.stage2Ran).toBe(true);
		expect(graph.findEntities({ type: "concept" }).length).toBeGreaterThan(0);
	});
});
