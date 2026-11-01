/**
 * term-intent.ts - detect a plain-words request to open a /term preset
 * ("run pi", "open hermes", "launch pi in a tab"), so the TUI opens it through
 * the same `/term <preset>` path without spending a single model token (#4764).
 *
 * Deliberately narrow. Only a short imperative whose object is a known preset
 * id matches. Anything with a task attached ("run pi on this repo and fix the
 * tests"), a non-preset object ("run the tests") or a question ("pi is broken,
 * why") returns null and falls through to the model.
 */

const VERBS = "run|open|start|launch|fire up|spin up|boot";
const POLITE = "(?:please\\s+|can you\\s+|could you\\s+)?";
const WHERE = "(?:\\s+in\\s+(?:a\\s+)?(?:new\\s+)?(?:tab|terminal(?:\\s+tab)?))?";
const PRESET_INTENT = new RegExp(
	`^${POLITE}(?:${VERBS})\\s+(?:up\\s+)?([a-z0-9][a-z0-9_-]*)(${WHERE})(?:\\s+please)?$`,
);

/**
 * Returns the `/term` args for a matching request, or null. `presetIds` is the
 * live preset list (listPresetIds()); an unknown name never matches.
 */
export function detectTermPresetIntent(
	input: string,
	presetIds: readonly string[],
): string[] | null {
	const text = input
		.trim()
		.toLowerCase()
		.replace(/[.!?]+$/, "")
		.replace(/\s+/g, " ");
	if (!text || text.length > 60) return null;
	const m = PRESET_INTENT.exec(text);
	if (!m) return null;
	const id = presetIds.find((p) => p.toLowerCase() === m[1]);
	if (!id) return null;
	// "in a tab" is an explicit ask for an in-tab PTY, which /term supports.
	return m[2] ? [id, "--in-tab"] : [id];
}
