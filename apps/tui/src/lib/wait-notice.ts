/**
 * The plain line shown when the model has gone quiet (pilot break 12).
 *
 * With a second session on the same local server, the model answers one request at a
 * time, so the later one sat on a spinner for about four minutes with nothing
 * saying why. The harness already tells the TUI after 45 s of silence
 * (onStall), but that text only reached a view nobody has open. This turns the
 * same signal into one chat line that names the model, once per quiet spell.
 */

/** The sentence. No jargon, names the model, says what the person can do. */
export function waitNotice(model: string, silentSeconds: number): string {
	const who = model.trim() || "The model";
	return `${who} has not answered for ${silentSeconds} s. It may be busy. Esc stops the turn.`;
}

/**
 * One notice per quiet spell per tab. The harness repeats onStall every 15 s;
 * only the first of a spell speaks, and a reply (silentSeconds null) re-arms it.
 */
export function createWaitNoticeGate(): (
	tabId: string,
	event: { silentSeconds: number | null; model: string },
) => string | null {
	const told = new Set<string>();
	return (tabId, { silentSeconds, model }) => {
		if (silentSeconds === null) {
			told.delete(tabId);
			return null;
		}
		if (told.has(tabId)) return null;
		told.add(tabId);
		return waitNotice(model, silentSeconds);
	};
}
