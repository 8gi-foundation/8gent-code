/**
 * visualiser-bridge — tiny pub/sub so the agent can notify the Thinking-box
 * visualiser without importing from apps/tui (apps depend on packages, not
 * the reverse).
 *
 * Wiring:
 *   apps/tui/src/app.tsx (or any TUI startup site) imports
 *     `setVisualiserTokenSink` and registers a sink that forwards each
 *     incoming token to `pushVisualiserToken` from the visualiser module.
 *   packages/eight/agent.ts imports `notifyVisualiserToken` and calls it
 *     on every onStepFinish step text. If no sink is registered, this is
 *     a silent no-op — the agent works fine without the TUI.
 *
 * The bridge intentionally has no React, no Ink, no fs. Pure module-level
 * state. One sink, last write wins. Multiple TUIs in the same process is
 * not a use case we support today; if it ever is, switch to a Set.
 */

export type VisualiserTokenSink = (token: string) => void;

let sink: VisualiserTokenSink | null = null;

/** Called by the TUI at startup. Pass null to disconnect. */
export function setVisualiserTokenSink(next: VisualiserTokenSink | null): void {
	sink = next;
}

/**
 * Called by the agent for each text fragment it produces. Splits on
 * whitespace into per-token nudges so the param vector breathes per word
 * rather than per long step. Best-effort: any error in the sink is
 * swallowed so the agent loop is never affected by visualiser issues.
 */
export function notifyVisualiserToken(text: string | undefined | null): void {
	if (!sink || !text) return;
	// Split on whitespace; cap to a reasonable count so a 2000-token step
	// doesn't perturb the vector 2000 times in a single tick.
	const parts = text.split(/\s+/).filter(Boolean).slice(0, 24);
	for (const part of parts) {
		try {
			sink(part);
		} catch {
			// ignore — visualiser failures must not break the agent
		}
	}
}

/** Test/debug helper. */
export function _hasSink(): boolean {
	return sink !== null;
}
