/** What a voice transcript becomes in the input: a spoken "slash" types "/" (#4949). Both voice paths call this. */
import { spokenSlash } from "../../../../packages/voice/spoken-slash";
import { BUILT_IN_SLASH_COMMANDS } from "./slash-commands";

/** Built-in command names and aliases, lowercase. */
export function knownSlashNames(): ReadonlySet<string> {
	const out = new Set<string>();
	for (const c of BUILT_IN_SLASH_COMMANDS) {
		out.add(c.name.toLowerCase());
		for (const a of c.aliases) out.add(a.toLowerCase());
	}
	return out;
}

export function voiceTranscriptText(text: string): string {
	return spokenSlash(text, knownSlashNames());
}
