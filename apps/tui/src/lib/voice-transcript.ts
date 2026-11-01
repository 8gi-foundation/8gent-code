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

// The skill and prompt-command names live in a module cache. The transcript path only ever reads
// it, so it is synchronous: no scan can hang a transcript or let an older one land after a newer.
let cachedTokens: readonly string[] = [];
let inflight: Promise<void> | null = null;

async function loadRegistryTokens(): Promise<string[]> {
	const { getSlashRegistry } = await import("./slash-registry.js");
	return [...(await getSlashRegistry()).byToken.keys()];
}

/**
 * Refresh the cache in the background. One scan at a time; a failed scan keeps the old cache; a
 * scan that hangs is abandoned after timeoutMs so the next call can try again. Never throws.
 */
export function refreshSlashNames(
	load: () => Promise<string[]> = loadRegistryTokens,
	timeoutMs = 10_000,
): Promise<void> {
	if (inflight) return inflight;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = (async () => {
		try {
			const tokens = await Promise.race([
				load(),
				new Promise<never>((_, rej) => {
					timer = setTimeout(() => rej(new Error("slash scan timed out")), timeoutMs);
				}),
			]);
			cachedTokens = tokens;
		} catch {
			// Keep what we had.
		} finally {
			clearTimeout(timer);
			inflight = null;
		}
	})();
	inflight = run;
	return run;
}

export function resetSlashNamesForTests(): void {
	cachedTokens = [];
	inflight = null;
}

/** The transcript as the input receives it. Synchronous: built-ins plus the cached skills and prompt commands. */
export function voiceTranscriptText(text: string): string {
	return voiceTranscriptTextWith(text, cachedTokens);
}
