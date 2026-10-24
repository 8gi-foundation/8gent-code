/** What a voice transcript becomes in the input: a spoken "slash" types "/" (#4949). Both voice paths call this. */
import { spokenSlash } from "../../../../packages/voice/spoken-slash";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands";

/**
 * Built-in command names and aliases, plus any extra registry tokens ("/deploy-check": skills and
 * the person's own prompt commands), lowercase. One-letter names are left out: "slash c is fine"
 * must never run /c.
 */
export function knownSlashNames(extraTokens: Iterable<string> = []): ReadonlySet<string> {
	const out = new Set<string>();
	const add = (n: string) => {
		const name = n.replace(/^\//, "").toLowerCase();
		if (name.length > 1) out.add(name);
	};
	for (const c of BUILT_IN_SLASH_COMMANDS) {
		add(c.name);
		for (const a of c.aliases) add(a);
	}
	for (const t of extraTokens) add(t);
	return out;
}

export function voiceTranscriptTextWith(text: string, extraTokens: Iterable<string>): string {
	return spokenSlash(text, knownSlashNames(extraTokens));
}

/** Built-ins only: no disk read. */
export function voiceTranscriptText(text: string): string {
	return voiceTranscriptTextWith(text, []);
}

/** With the skills and prompt commands the slash menu knows. Falls back to built-ins if the scan fails. */
export async function voiceTranscriptTextWithRegistry(text: string): Promise<string> {
	try {
		const { getSlashRegistry } = await import("./slash-registry.js");
		return voiceTranscriptTextWith(text, (await getSlashRegistry()).byToken.keys());
	} catch {
		return voiceTranscriptText(text);
	}
}
