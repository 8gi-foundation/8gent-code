/**
 * Byte-stream decoder for @8gent/eight-bdh.
 *
 * The model is byte-level (vocab_size=256). It emits a JSON byte stream of the
 * shape `<DECISION_JSON>\n<TRACE_JSON>\n` (spec §8 of training notes). decode()
 * extracts the Decision; extractTrace() maps activations into an AuditTrace
 * given a concept-id lookup table (Solomon's ontology owns the IDs).
 */

import type {
	Decision,
	DecisionKind,
	AuditTrace,
	ConceptId,
} from "./types";

const DECISION_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
	"model",
	"agent",
	"tool",
	"reject",
	"clarify",
]);

export function decode(bytes: Uint8Array): Decision {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const firstNewline = text.indexOf("\n");
	const head = firstNewline === -1 ? text : text.slice(0, firstNewline);

	let parsed: unknown;
	try {
		parsed = JSON.parse(head);
	} catch (err) {
		throw new Error(
			`decode: failed to parse decision JSON from byte stream (head=${JSON.stringify(head.slice(0, 80))}): ${(err as Error).message}`,
		);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("decode: decision payload is not an object");
	}

	const obj = parsed as Record<string, unknown>;
	const kind = obj.kind;
	if (typeof kind !== "string" || !DECISION_KINDS.has(kind as DecisionKind)) {
		throw new Error(`decode: invalid decision.kind=${String(kind)}`);
	}

	const target = obj.target;
	if (typeof target !== "string") {
		throw new Error("decode: decision.target must be a string");
	}

	const budget = obj.budget as { tokens?: unknown; ms?: unknown } | undefined;
	if (
		!budget ||
		typeof budget.tokens !== "number" ||
		typeof budget.ms !== "number"
	) {
		throw new Error("decode: decision.budget must be { tokens:number, ms:number }");
	}

	const confidence = obj.confidence;
	if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
		throw new Error("decode: decision.confidence must be a number in [0,1]");
	}

	return {
		kind: kind as DecisionKind,
		target,
		budget: { tokens: budget.tokens, ms: budget.ms },
		confidence,
	};
}

export interface ExtractTraceOptions {
	topK?: number;
	threshold?: number;
}

export function extractTrace(
	activations: Float32Array,
	conceptIds: ConceptId[],
	opts: ExtractTraceOptions = {},
): AuditTrace {
	// TODO(james): finalise once Solomon publishes ontology.json and the concept head
	// width is locked. The mapping is positional: activations[i] corresponds to conceptIds[i].
	if (activations.length !== conceptIds.length) {
		throw new Error(
			`extractTrace: activations.length=${activations.length} does not match conceptIds.length=${conceptIds.length}. Ontology width mismatch.`,
		);
	}

	const topK = opts.topK ?? 12;
	const threshold = opts.threshold ?? 0;

	const scored: { concept: ConceptId; weight: number }[] = [];
	for (let i = 0; i < activations.length; i++) {
		const w = activations[i];
		if (w === undefined) continue;
		if (w > threshold) {
			scored.push({ concept: conceptIds[i] as ConceptId, weight: w });
		}
	}
	scored.sort((a, b) => b.weight - a.weight);

	const topActivations = scored.slice(0, topK);
	const synapseIds = topActivations.map((s) => s.concept);

	return {
		synapseIds,
		topActivations,
		reasoningChain: [],
	};
}
