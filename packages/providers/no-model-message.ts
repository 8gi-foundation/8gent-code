/**
 * What a user reads when a hosted provider has no model to start with.
 *
 * The list fetch fails for different reasons and the fix differs: no usable key
 * (add one), a rejected key (replace it), or a network failure (retry). The old
 * text blamed the list in every case, so a one-character pasted key read as a
 * provider outage. Pure: nothing here reads the disk or the net, and no key is
 * ever printed (only its length).
 */

/** Real provider keys are far longer; anything shorter is a bad paste. */
export const MIN_KEY_CHARS = 8;

export function keyLooksUsable(key: string | null | undefined): boolean {
	return (key ?? "").trim().length >= MIN_KEY_CHARS;
}

/**
 * The one place an upstream error's own text is shown. It can carry a URL with
 * `user:pass@` in it (a declared baseUrl) or a server's echo of the key, so both
 * are cut before display (8SO, #4681).
 */
function scrub(msg: string, key: string | null | undefined): string {
	let out = msg.replace(/(\/\/)[^/\s@]+@/g, "$1");
	const k = (key ?? "").trim();
	if (k.length >= MIN_KEY_CHARS) out = out.split(k).join("[key]");
	return out;
}

export function noModelMessage(opts: {
	displayName: string;
	/** Provider id for `8gent keys set <id>`; defaults to the lowercased display name. */
	provider?: string;
	keyEnv: string;
	key: string | null | undefined;
	err?: unknown;
	/** The tail for a network failure: "Pass --model <name>." or "Pick a model with /model." */
	pickHint: string;
}): string {
	const { displayName, keyEnv, key, err, pickHint } = opts;
	const id = opts.provider || displayName.toLowerCase().replace(/\s+/g, "");
	if (keyEnv) {
		const n = (key ?? "").trim().length;
		if (n === 0)
			return `No ${displayName} key found. Run \`8gent keys set ${id}\` to add ${keyEnv}, or \`8gent keys\` to edit the file.`;
		if (n < MIN_KEY_CHARS)
			return `The ${keyEnv} value is only ${n} character${n === 1 ? "" : "s"}, too short to be a real key. Run \`8gent keys set ${id}\` to replace it.`;
	}
	const msg = err instanceof Error ? err.message : err ? String(err) : "";
	const status = /: (\d{3})\b/.exec(msg)?.[1];
	if (status === "401" || status === "403") {
		return `${displayName} rejected the key (HTTP ${status}). Run \`8gent keys set ${id}\` to replace ${keyEnv || "it"}.`;
	}
	if (status)
		return `No model chosen for ${displayName}: its model list request failed with HTTP ${status}. ${pickHint}`;
	if (/timed out/i.test(msg))
		return `No model chosen for ${displayName}: its model list request timed out. ${pickHint}`;
	if (msg)
		return `No model chosen for ${displayName}: could not reach its model list (${scrub(msg, key).slice(0, 120)}). ${pickHint}`;
	return `No model chosen for ${displayName}: its model list came back empty. ${pickHint}`;
}
