/**
 * Stage-2 triple-extraction prompt for the video knowledge-graph lane.
 *
 * VIDEO-INGESTION spec 9.2 / 9.3 / open-question 15.3: the event/transcript
 * to-triple prompt is a versioned constant, not an inline throwaway string,
 * so a change to extraction behaviour is a reviewable diff.
 *
 * Stage 1 (the Marlin + Whisper sidecar) produces grounded natural-language
 * facts. Stage 2 turns each fact - a visual event description, a transcript
 * segment, or a fused pair of both - into graph triples that conform to the
 * existing EntityType / RelationshipType enums (graph.ts).
 *
 * The model must return strict JSON; the caller guards the output with
 * json-guard.ts. The prompt never names a vendor brand.
 */

/** Bump on any change to the prompt body. Lets a reviewer pin extraction behaviour. */
export const VIDEO_TRIPLE_PROMPT_VERSION = "1.0.0";

/** The entity types stage-2 may emit. Mirrors graph.ts EntityType. */
const ALLOWED_ENTITY_TYPES = [
	"concept",
	"person",
	"file",
	"function",
	"package",
	"tool",
	"decision",
] as const;

/** The relationship types stage-2 may emit. Mirrors graph.ts RelationshipType. */
const ALLOWED_RELATIONSHIP_TYPES = ["mentions", "related_to", "uses", "implements"] as const;

/** Input to one stage-2 extraction unit (spec 9.3). */
export interface VideoTripleInput {
	/** "visual" = a Marlin event, "audio" = a Whisper segment, "fused" = both overlap. */
	modality: "visual" | "audio" | "fused";
	/** The visual event description, if this unit has a visual side. */
	eventDescription?: string;
	/** The transcript text, if this unit has an audio side. */
	transcriptText?: string;
	/** Media-relative span this unit covers, for the model's context only. */
	start: number;
	end: number;
}

/** Render one input unit as a labelled block for the prompt. */
function renderUnit(unit: VideoTripleInput): string {
	const span = `${unit.start.toFixed(1)}s-${unit.end.toFixed(1)}s`;
	const lines = [`[${unit.modality} | ${span}]`];
	if (unit.eventDescription) lines.push(`SEEN: ${unit.eventDescription}`);
	if (unit.transcriptText) lines.push(`SAID: ${unit.transcriptText}`);
	return lines.join("\n");
}

/**
 * Build the full stage-2 prompt for a batch of input units.
 *
 * The model is asked to return a single JSON object:
 *   { "entities": ExtractedEntity[], "relationships": ExtractedRelationship[] }
 * keyed exactly to the extractor.ts shapes. Provenance metadata (source,
 * videoId, start, end, modality) is added by video-extractor.ts after the
 * model returns - the model is not asked to produce it.
 */
export function buildVideoTriplePrompt(units: VideoTripleInput[]): string {
	const unitBlocks = units.map(renderUnit).join("\n\n");

	return [
		"You extract knowledge-graph triples from a video.",
		"Each block below is one moment, tagged with its modality and time span.",
		"SEEN is what the camera observed. SAID is what was spoken. A fused block has both,",
		"describing the same moment - resolve them to the SAME entities, not duplicates.",
		"",
		"For each block, extract the concrete entities and relationships it implies.",
		"",
		`Allowed entity types: ${ALLOWED_ENTITY_TYPES.join(", ")}.`,
		`Allowed relationship types: ${ALLOWED_RELATIONSHIP_TYPES.join(", ")}.`,
		"",
		"Rules:",
		"- Prefer specific, reusable names (a tool name, a person name, a named concept).",
		"- Do not invent facts not present in the block.",
		"- Skip a block that implies nothing concrete; emit no entity for it.",
		"- A relationship's fromName/toName MUST match an entity name you emit.",
		'- Do NOT emit "video" or "event" entities or "occurs_in"/"precedes" relationships;',
		"  the caller adds those from the timeline. You only emit content triples.",
		"",
		"Return ONLY a JSON object, no prose, no code fence:",
		'{ "entities": [ { "type": "...", "name": "...", "description": "..." } ],',
		'  "relationships": [ { "fromName": "...", "fromType": "...", "toName": "...", "toType": "...", "type": "..." } ] }',
		"",
		"BLOCKS:",
		unitBlocks,
	].join("\n");
}

export { ALLOWED_ENTITY_TYPES, ALLOWED_RELATIONSHIP_TYPES };
