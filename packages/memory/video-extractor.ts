/**
 * VideoExtractor - knowledge-graph ingestion for video (VIDEO-INGESTION spec 9).
 *
 * Closes the gap in extractor.ts: there was no video source. This file turns a
 * `VideoExtraction` (the frozen contract from `@8gent/eyes`, produced by the
 * `extract_video` tool) into `ExtractedEntity[]` + `ExtractedRelationship[]`
 * that compose with the existing graph upsert + concept-linker path.
 *
 * Two stages (spec 9.2):
 *   - Stage 1 (perception) happens upstream: the Marlin + Whisper sidecar
 *     produces the VideoExtraction. This file does not perceive.
 *   - Stage 2 (schema) runs here: an LLM pass turns each event description,
 *     transcript segment, or fused pair into graph triples.
 *
 * Fusion (spec 9.3): events (seen) and transcript segments (said) share one
 * media timeline. Where an event and a segment overlap (interval
 * intersection), both are passed to stage 2 together so a spoken sentence and
 * a visual moment at the same time resolve to the same node. Non-overlapping
 * segments are extracted alone.
 *
 * The stage-2 LLM call is injectable (`VideoTripleExtractorFn`) so unit tests
 * run without a live model. Only the plumbing and fusion logic are tested;
 * the extraction QUALITY of a real model is not validated here.
 *
 * Storage (spec 9.6): the graph stores `path`, the `videoId` hash, summaries,
 * and triples only. Never raw frames, raw audio, or video bytes.
 */

import type { TranscriptSegment, VideoEvent, VideoExtraction } from "@8gent/eyes";
import type { ExtractedEntity, ExtractedRelationship, ExtractionResult } from "./extractor.js";
import type { EntityType, KnowledgeGraph, RelationshipType } from "./graph.js";
import { safeJsonParse } from "./json-guard.js";
import {
	ALLOWED_ENTITY_TYPES,
	ALLOWED_RELATIONSHIP_TYPES,
	VIDEO_TRIPLE_PROMPT_VERSION,
	type VideoTripleInput,
	buildVideoTriplePrompt,
} from "./prompts/video-triple-extraction.js";

// ============================================
// Stage-2 LLM injection point
// ============================================

/**
 * The stage-2 LLM call. Receives a fully-rendered prompt, returns the raw
 * model output (expected to be a JSON object string). Injectable so tests
 * supply a mock returning fixed triples; production wires the 8gent text
 * provider. Kept as a bare function type so the memory package does not take
 * a hard dependency on the providers package.
 */
export type VideoTripleExtractorFn = (prompt: string) => Promise<string>;

/** The JSON shape stage-2 is asked to return (see the prompt file). */
interface RawTripleOutput {
	entities?: Array<{ type?: string; name?: string; description?: string }>;
	relationships?: Array<{
		fromName?: string;
		fromType?: string;
		toName?: string;
		toType?: string;
		type?: string;
	}>;
}

// ============================================
// Provenance + tuning constants
// ============================================

/** Modality of a derived node, recorded in provenance metadata (spec 9.5). */
export type VideoModality = "visual" | "audio" | "fused";

/** Provenance metadata stamped on every video-derived entity/relationship. */
export interface VideoProvenance {
	source: "video";
	videoId: string;
	start: number;
	end: number;
	modality: VideoModality;
}

const ENTITY_TYPE_SET = new Set<string>(ALLOWED_ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set<string>(ALLOWED_RELATIONSHIP_TYPES);

// ============================================
// Public ingest options
// ============================================

export interface VideoExtractorOptions {
	/** Stage-2 LLM call. If omitted, stage-2 is skipped and only the */
	/** timeline triples (video / event / occurs_in / precedes) are emitted. */
	extractTriples?: VideoTripleExtractorFn;
	/** Max input units per stage-2 call. Batches keep prompts bounded. Default 12. */
	batchSize?: number;
}

// ============================================
// Fusion: interval overlap on the media timeline
// ============================================

/**
 * A unit of stage-2 input: either a lone event, a lone transcript segment,
 * or a fused pair. Carries the span + modality so provenance can be stamped.
 */
interface FusedUnit {
	modality: VideoModality;
	event?: VideoEvent;
	segment?: TranscriptSegment;
	start: number;
	end: number;
}

/** True if [aStart,aEnd] and [bStart,bEnd] intersect on the timeline. */
export function intervalsOverlap(
	aStart: number,
	aEnd: number,
	bStart: number,
	bEnd: number,
): boolean {
	return aStart < bEnd && bStart < aEnd;
}

/**
 * Fuse events and transcript segments on the shared media timeline
 * (spec 9.3). An event and a segment that overlap become one `fused` unit;
 * a segment or event with no overlap becomes a lone unit. Every event and
 * every segment appears in exactly one unit.
 *
 * Determinism: events and segments are processed in start-time order, and an
 * event fuses with the FIRST not-yet-consumed segment it overlaps. This makes
 * the fusion reproducible for the unit tests.
 */
export function fuseTimeline(events: VideoEvent[], transcript: TranscriptSegment[]): FusedUnit[] {
	const sortedEvents = events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
	const sortedSegments = transcript.slice().sort((a, b) => a.start - b.start || a.end - b.end);

	const units: FusedUnit[] = [];
	const consumedSegments = new Set<number>();

	for (const event of sortedEvents) {
		let fusedIdx = -1;
		for (let i = 0; i < sortedSegments.length; i++) {
			if (consumedSegments.has(i)) continue;
			const seg = sortedSegments[i];
			if (intervalsOverlap(event.start, event.end, seg.start, seg.end)) {
				fusedIdx = i;
				break;
			}
		}

		if (fusedIdx >= 0) {
			const seg = sortedSegments[fusedIdx];
			consumedSegments.add(fusedIdx);
			units.push({
				modality: "fused",
				event,
				segment: seg,
				start: Math.min(event.start, seg.start),
				end: Math.max(event.end, seg.end),
			});
		} else {
			units.push({
				modality: "visual",
				event,
				start: event.start,
				end: event.end,
			});
		}
	}

	// Any transcript segment not consumed by an overlap is extracted alone.
	for (let i = 0; i < sortedSegments.length; i++) {
		if (consumedSegments.has(i)) continue;
		const seg = sortedSegments[i];
		units.push({
			modality: "audio",
			segment: seg,
			start: seg.start,
			end: seg.end,
		});
	}

	// Stable timeline order so precedes-edges and tests are deterministic.
	return units.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ============================================
// Triple emission
// ============================================

/** Deterministic event entity name: stable id keyed to the video + span. */
function eventName(videoId: string, start: number, end: number): string {
	return `${videoId}@${start.toFixed(2)}-${end.toFixed(2)}`;
}

/** Build the provenance metadata block for a derived node (spec 9.5). */
function provenance(
	videoId: string,
	start: number,
	end: number,
	modality: VideoModality,
): VideoProvenance {
	return { source: "video", videoId, start, end, modality };
}

/**
 * Parse and validate the stage-2 model output. Guarded by safeJsonParse so a
 * double-encoded string is healed; an unparseable or off-schema output yields
 * an empty result rather than throwing - stage-2 failure must not abort
 * ingestion of the timeline triples.
 */
function parseTripleOutput(raw: string): {
	entities: ExtractedEntity[];
	relationships: ExtractedRelationship[];
} {
	let parsed: RawTripleOutput;
	try {
		parsed = safeJsonParse<RawTripleOutput>(raw);
	} catch {
		return { entities: [], relationships: [] };
	}
	if (!parsed || typeof parsed !== "object") {
		return { entities: [], relationships: [] };
	}

	const entities: ExtractedEntity[] = [];
	for (const e of parsed.entities ?? []) {
		if (!e || typeof e.name !== "string" || e.name.trim().length === 0) continue;
		if (typeof e.type !== "string" || !ENTITY_TYPE_SET.has(e.type)) continue;
		entities.push({
			type: e.type as EntityType,
			name: e.name.trim(),
			description: typeof e.description === "string" ? e.description : undefined,
		});
	}

	const relationships: ExtractedRelationship[] = [];
	for (const r of parsed.relationships ?? []) {
		if (!r || typeof r.type !== "string" || !RELATIONSHIP_TYPE_SET.has(r.type)) continue;
		if (
			typeof r.fromName !== "string" ||
			typeof r.toName !== "string" ||
			typeof r.fromType !== "string" ||
			typeof r.toType !== "string"
		) {
			continue;
		}
		if (!ENTITY_TYPE_SET.has(r.fromType) || !ENTITY_TYPE_SET.has(r.toType)) continue;
		relationships.push({
			fromName: r.fromName.trim(),
			fromType: r.fromType as EntityType,
			toName: r.toName.trim(),
			toType: r.toType as EntityType,
			type: r.type as RelationshipType,
		});
	}

	return { entities, relationships };
}

// ============================================
// The extractor
// ============================================

/**
 * Turn a `VideoExtraction` into an `ExtractionResult` (spec 9). The result
 * composes with `applyExtraction` / entity-dedup / concept-linker exactly
 * like `extractFromToolResult`'s output.
 *
 * Always emitted, no LLM needed:
 *   - the source video as a `video` entity, keyed by `videoId` (re-ingest of
 *     the same videoId upserts, never duplicates - spec 13);
 *   - one `event` entity per fused unit, with provenance;
 *   - `occurs_in` (event -> video);
 *   - `precedes` (event -> next event by start time).
 *
 * Emitted only when `extractTriples` is supplied (stage 2):
 *   - content entities/relationships from the model;
 *   - `mentions` (event -> each concept/person the model surfaced for it).
 */
export async function extractFromVideo(
	extraction: VideoExtraction,
	options: VideoExtractorOptions = {},
): Promise<ExtractionResult> {
	const entities: ExtractedEntity[] = [];
	const relationships: ExtractedRelationship[] = [];

	const { videoId } = extraction;

	// --- The source video entity (spec 9.6: path + hash + summary only) ----
	entities.push({
		type: "video",
		name: videoId,
		description: extraction.scene || `Video at ${extraction.path}`,
		metadata: {
			source: "video",
			videoId,
			path: extraction.path,
			durationSec: extraction.durationSec,
			chunked: extraction.chunked,
			chunkCount: extraction.chunkCount,
			models: extraction.models,
			generatedAt: extraction.generatedAt,
			eventCount: extraction.events.length,
			transcriptSegments: extraction.transcript.length,
		},
	});

	// --- Fuse the timeline (spec 9.3) --------------------------------------
	const units = fuseTimeline(extraction.events, extraction.transcript);

	// --- One event entity per unit + occurs_in + precedes ------------------
	const eventNames: string[] = [];
	for (const unit of units) {
		const name = eventName(videoId, unit.start, unit.end);
		eventNames.push(name);

		const description = unit.event?.description ?? unit.segment?.text ?? "Video moment";
		entities.push({
			type: "event",
			name,
			description,
			metadata: {
				...provenance(videoId, unit.start, unit.end, unit.modality),
				...(unit.event ? { seen: unit.event.description } : {}),
				...(unit.segment ? { said: unit.segment.text } : {}),
			},
		});

		// event occurs_in video
		relationships.push({
			fromName: name,
			fromType: "event",
			toName: videoId,
			toType: "video",
			type: "occurs_in",
			metadata: { ...provenance(videoId, unit.start, unit.end, unit.modality) },
		});
	}

	// event precedes next event, in timeline order
	for (let i = 0; i < eventNames.length - 1; i++) {
		const cur = units[i];
		relationships.push({
			fromName: eventNames[i],
			fromType: "event",
			toName: eventNames[i + 1],
			toType: "event",
			type: "precedes",
			metadata: { ...provenance(videoId, cur.start, cur.end, cur.modality) },
		});
	}

	// --- Stage 2: LLM triple extraction (spec 9.2) -------------------------
	if (options.extractTriples) {
		await runStage2(extraction, units, eventNames, options, entities, relationships);
	}

	return { entities, relationships };
}

/**
 * Run stage-2 over the fused units in batches. Each emitted content entity is
 * tagged with provenance; each content entity is also linked back to the
 * event it came from via a `mentions` edge so the graph stays time-queryable.
 */
async function runStage2(
	extraction: VideoExtraction,
	units: FusedUnit[],
	eventNames: string[],
	options: VideoExtractorOptions,
	entities: ExtractedEntity[],
	relationships: ExtractedRelationship[],
): Promise<void> {
	const extractTriples = options.extractTriples;
	if (!extractTriples) return;

	const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 12;
	const { videoId } = extraction;

	for (let offset = 0; offset < units.length; offset += batchSize) {
		const batch = units.slice(offset, offset + batchSize);
		const inputs: VideoTripleInput[] = batch.map((u) => ({
			modality: u.modality,
			eventDescription: u.event?.description,
			transcriptText: u.segment?.text,
			start: u.start,
			end: u.end,
		}));

		let raw: string;
		try {
			raw = await extractTriples(buildVideoTriplePrompt(inputs));
		} catch {
			// A failed stage-2 batch is non-fatal: the timeline triples for
			// this batch are already emitted. Skip the batch and continue.
			continue;
		}

		const { entities: stageEntities, relationships: stageRels } = parseTripleOutput(raw);

		// The whole batch shares one span for provenance: the batch envelope.
		const batchStart = Math.min(...batch.map((u) => u.start));
		const batchEnd = Math.max(...batch.map((u) => u.end));
		const batchModality: VideoModality = batch.some((u) => u.modality === "fused")
			? "fused"
			: batch.every((u) => u.modality === "audio")
				? "audio"
				: "visual";

		for (const e of stageEntities) {
			entities.push({
				...e,
				metadata: {
					...(e.metadata ?? {}),
					...provenance(videoId, batchStart, batchEnd, batchModality),
					promptVersion: VIDEO_TRIPLE_PROMPT_VERSION,
				},
			});
		}
		for (const r of stageRels) {
			relationships.push({
				...r,
				metadata: {
					...(r.metadata ?? {}),
					...provenance(videoId, batchStart, batchEnd, batchModality),
				},
			});
		}

		// mentions: each event in the batch -> each content entity surfaced
		// for that batch. Time-queryability: the event keeps its exact span,
		// the mention edge carries it.
		for (let i = 0; i < batch.length; i++) {
			const unit = batch[i];
			const evName = eventNames[offset + i];
			const evProv = provenance(videoId, unit.start, unit.end, unit.modality);
			for (const e of stageEntities) {
				relationships.push({
					fromName: evName,
					fromType: "event",
					toName: e.name,
					toType: e.type,
					type: "mentions",
					metadata: { ...evProv },
				});
			}
		}
	}
}

// ============================================
// End-to-end ingest into a KnowledgeGraph
// ============================================

export interface VideoIngestResult {
	videoId: string;
	entitiesCreated: number;
	relationshipsCreated: number;
	stage2Ran: boolean;
}

/**
 * Ingest a `VideoExtraction` end-to-end into a `KnowledgeGraph`. Mirrors the
 * upsert logic of `applyExtraction` in index.ts (name -> id map, then
 * relationships), so a caller can take a VideoExtraction straight to graph
 * nodes. Re-ingest of the same `videoId` upserts the `video` node rather than
 * duplicating it (the graph's UNIQUE(type,name) handles this).
 */
export async function ingestVideoToGraph(
	graph: KnowledgeGraph,
	extraction: VideoExtraction,
	options: VideoExtractorOptions = {},
): Promise<VideoIngestResult> {
	const result = await extractFromVideo(extraction, options);

	const nameToId = new Map<string, string>();
	for (const entity of result.entities) {
		const id = graph.addEntity(entity.type, entity.name, {
			description: entity.description,
			metadata: entity.metadata,
		});
		nameToId.set(entity.name, id);
	}

	let relationshipsCreated = 0;
	for (const rel of result.relationships) {
		const fromId = nameToId.get(rel.fromName);
		const toId = nameToId.get(rel.toName);
		if (fromId && toId) {
			graph.addRelationship(fromId, toId, rel.type, rel.metadata);
			relationshipsCreated++;
		}
	}

	return {
		videoId: extraction.videoId,
		entitiesCreated: result.entities.length,
		relationshipsCreated,
		stage2Ran: Boolean(options.extractTriples),
	};
}
