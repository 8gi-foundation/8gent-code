/**
 * The daemon-side seam.
 *
 * Runs in exactly the same place as packages/verify's checker: after an
 * officer's reply is generated, before store.postMessage. The officer's chat
 * model never sees the composer, never sees a hex, and never sees the lattice.
 * It emitted an intent; it gets back a summary.
 *
 * This package does NOT edit table-routes.ts. Concurrent agents are working in
 * that file, and a design substrate is not worth a merge conflict in the live
 * mention flow. The hook is documented in README.md and is four lines.
 */

import { search } from "./compose";
import { parseDesignMarkers } from "./marker";
import { toSummary, toTokens } from "./render";
import { DesignRefused, type DesignSpec } from "./types";

/**
 * Whatever appends to the daemon's ledger. In the daemon this is the live Table
 * Ledger (single writer, daemon-owned); in tests, a temp ledger. This package
 * never opens the live ledger itself - the caller injects it, same contract as
 * packages/verify.
 */
export interface LedgerLike {
	append(input: { kind: string; payload: Record<string, unknown> }): unknown;
}

export const DESIGN_LEDGER_KIND = "design.composed";
export const DESIGN_REFUSED_LEDGER_KIND = "design.refused";

export interface DesignOutcome {
	/** The reply with every marker replaced by a summary or a refusal notice. */
	text: string;
	/** Specs composed, in marker order. Empty when every marker was refused. */
	specs: DesignSpec[];
	/** Refusals, surfaced not swallowed. */
	refusals: { rule: string; detail: string }[];
	/** True when at least one marker was present. */
	handled: boolean;
}

export interface DesignOptions {
	ledger?: LedgerLike;
	/** Cap on candidates per marker, regardless of what the marker asked for. */
	maxCandidates?: number;
}

/**
 * Resolve every [[DESIGN]] marker in a reply.
 *
 * A refusal is rendered INTO the channel message rather than hidden. Same
 * deliberate deviation packages/verify makes: in a governance channel an
 * officer's error is signal, and quietly substituting a legal design for the
 * illegal one it asked for would teach nobody anything.
 */
export function renderDesignMarkers(reply: string, opts: DesignOptions = {}): DesignOutcome {
	const markers = parseDesignMarkers(reply);
	if (markers.length === 0) {
		return { text: reply, specs: [], refusals: [], handled: false };
	}

	let text = reply;
	const specs: DesignSpec[] = [];
	const refusals: { rule: string; detail: string }[] = [];

	for (const marker of markers) {
		const candidates = Math.min(marker.candidates, opts.maxCandidates ?? 64);
		let replacement: string;

		try {
			const result = search(marker.intent, candidates);
			specs.push(result.best);
			const refusedNote = result.refusals.length
				? ` (${result.refusals.length} of ${result.considered} candidates refused)`
				: "";
			replacement = `${toSummary(result.best)}${refusedNote}`;
			opts.ledger?.append({
				kind: DESIGN_LEDGER_KIND,
				payload: {
					id: result.best.id,
					intent: marker.intent,
					coordinate: result.best.coordinate,
					score: result.best.score,
					considered: result.considered,
					refused: result.refusals.length,
					tokens: toTokens(result.best),
				},
			});
		} catch (err) {
			const rule = err instanceof DesignRefused ? err.rule : "design.error";
			const detail = err instanceof Error ? err.message : String(err);
			refusals.push({ rule, detail });
			replacement = `[design refused: ${rule}] ${detail}`;
			opts.ledger?.append({
				kind: DESIGN_REFUSED_LEDGER_KIND,
				payload: { intent: marker.intent, rule, detail },
			});
		}

		text = text.replace(marker.raw, replacement);
	}

	return { text, specs, refusals, handled: true };
}
