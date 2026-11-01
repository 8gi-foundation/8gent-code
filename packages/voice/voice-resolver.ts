/**
 * 8gent Code - Spoken voice resolver
 *
 * Decides which engine and voice speak a line (the onboarding greeting and
 * the onboarding questions). The rule:
 *
 *   1. KittenTTS only when the user explicitly chose it (engine === "kitten").
 *      It is a small local model and sounds robotic on many machines, so it is
 *      never the default.
 *   2. Otherwise the macOS `say` engine, with the first usable voice of:
 *        a. the voice picked during onboarding, if installed
 *        b. settings.json `voice.ttsVoice`, if installed
 *        c. the most natural installed voice (Premium, then Enhanced or
 *           Siri-style neural, then a good standard voice such as Samantha)
 *   3. Not macOS: no speech. The existing onboarding speech is `say` and
 *      KittenTTS playback is `afplay`, both macOS-only, so the previous
 *      behaviour off macOS was already silence. We keep that, without a crash.
 *
 * "Installed" matters: `say -v <unknown>` does not fail, macOS silently swaps
 * in another voice. That is how the old "Bruno" default ended up speaking
 * through a voice nobody chose.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "../core/home.js";

export type SystemVoiceQuality = "premium" | "enhanced" | "siri" | "standard";

export interface SystemVoice {
	/** Exact name to pass to `say -v`, e.g. "Ava (Premium)". */
	name: string;
	/** Locale as printed by `say -v '?'`, e.g. "en_US". */
	locale: string;
	quality: SystemVoiceQuality;
}

export interface SpeechVoicePreference {
	engine?: string | null;
	voiceId?: string | null;
}

export interface ResolveSpeechVoiceInput {
	platform: string;
	/** settings.json `voice.ttsVoice`. */
	settingsVoice?: string | null;
	/** The onboarding user preference (`user.json` preferences.voice). */
	preference?: SpeechVoicePreference | null;
	/** Installed system voices, or null when the list could not be read. */
	installed: SystemVoice[] | null;
}

export type ResolvedSpeechVoice =
	| { engine: "system"; voice: string }
	| { engine: "kitten"; voice: string }
	| { engine: "none"; voice: null };

/** Voices shipped by KittenTTS. Valid only on the kitten engine. */
export const KITTEN_VOICES = ["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"];

/** Used when the installed list cannot be read. Ships with every macOS. */
export const FALLBACK_SYSTEM_VOICE = "Samantha";

/** Good standard voices, best first. Anything else standard is not auto-picked. */
const PREFERRED_STANDARD = [
	"Ava",
	"Samantha",
	"Daniel",
	"Serena",
	"Karen",
	"Moira",
	"Tom",
	"Allison",
	"Susan",
	"Alex",
];

/** Locales we would rather hear first, in order. Any other English follows. */
const PREFERRED_LOCALES = ["en_GB", "en_IE", "en_US", "en_AU", "en_IN"];

const QUALITY_RANK: Record<SystemVoiceQuality, number> = {
	premium: 3,
	enhanced: 2,
	siri: 2,
	standard: 1,
};

const LINE = /^(.*\S)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#\s?(.*)$/;

/** Parse `say -v '?'` output. Duplicate names (Siri variants) are merged. */
export function parseSayVoiceList(output: string): SystemVoice[] {
	const byName = new Map<string, SystemVoice>();
	for (const raw of output.split("\n")) {
		const m = raw.match(LINE);
		if (!m) continue;
		const [, name, locale, sample] = m;
		let quality: SystemVoiceQuality = "standard";
		if (/\(Premium\)$/i.test(name)) quality = "premium";
		else if (/\(Enhanced\)$/i.test(name)) quality = "enhanced";
		// Siri neural voices ship a "Hi, I'm Siri!" sample line. The name shape
		// "Name (Language (Region))" alone is not enough: the novelty voices
		// (Eddy, Grandpa, Reed...) print the same way.
		else if (/siri/i.test(sample)) quality = "siri";
		const prev = byName.get(name);
		if (!prev || QUALITY_RANK[quality] > QUALITY_RANK[prev.quality]) {
			byName.set(name, { name, locale, quality });
		}
	}
	return [...byName.values()];
}

function baseName(name: string): string {
	return name.replace(/\s*\(.*$/, "").trim();
}

/** The user's locale as "en_US", from the environment. Empty when unknown. */
export function systemLocale(): string {
	const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "";
	return raw.split(".")[0].replace("-", "_");
}

function localeRank(locale: string): number {
	const i = PREFERRED_LOCALES.indexOf(locale);
	return i === -1 ? PREFERRED_LOCALES.length : i;
}

/**
 * The most natural installed English voice, or null. Standard voices are only
 * considered from PREFERRED_STANDARD, which keeps novelty voices (Zarvox,
 * Bad News, Grandpa...) out.
 */
export function pickNaturalSystemVoice(
	voices: SystemVoice[],
	userLocale: string = systemLocale(),
): string | null {
	const candidates = voices.filter((v) => {
		if (!v.locale.startsWith("en_")) return false;
		if (v.quality !== "standard") return true;
		return PREFERRED_STANDARD.includes(v.name);
	});
	if (candidates.length === 0) return null;
	const nameRank = (v: SystemVoice) => {
		const i = PREFERRED_STANDARD.indexOf(baseName(v.name));
		return i === -1 ? PREFERRED_STANDARD.length : i;
	};
	// A voice from the user's own region beats a higher-quality voice with a
	// different accent: an en_US user should not get an en_IN Siri voice by default.
	const own = (v: SystemVoice) => (v.locale === userLocale ? 0 : 1);
	const sorted = [...candidates].sort(
		(a, b) =>
			own(a) - own(b) ||
			QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] ||
			nameRank(a) - nameRank(b) ||
			localeRank(a.locale) - localeRank(b.locale),
	);
	return sorted[0].name;
}

/**
 * Find a requested voice among the installed ones. "Ava" matches "Ava",
 * then the best quality variant such as "Ava (Premium)". Case-insensitive.
 */
function findInstalled(requested: string, installed: SystemVoice[]): string | null {
	const want = requested.trim().toLowerCase();
	if (!want) return null;
	const exact = installed.find((v) => v.name.toLowerCase() === want);
	if (exact) return exact.name;
	const variants = installed
		.filter((v) => baseName(v.name).toLowerCase() === want)
		.sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]);
	return variants[0]?.name ?? null;
}

function usableSystemVoice(
	requested: string | null | undefined,
	installed: SystemVoice[] | null,
): string | null {
	const name = requested?.trim();
	if (!name) return null;
	// A KittenTTS name is never a system voice, even if the list is unknown.
	if (KITTEN_VOICES.includes(name)) return null;
	if (installed === null) return name;
	return findInstalled(name, installed);
}

export function resolveSpeechVoice(input: ResolveSpeechVoiceInput): ResolvedSpeechVoice {
	if (input.platform !== "darwin") return { engine: "none", voice: null };

	const pref = input.preference ?? null;
	if (pref?.engine === "kitten") {
		const id = pref.voiceId?.trim() ?? "";
		return { engine: "kitten", voice: KITTEN_VOICES.includes(id) ? id : "Bruno" };
	}

	const picked = usableSystemVoice(pref?.voiceId, input.installed);
	if (picked) return { engine: "system", voice: picked };

	const fromSettings = usableSystemVoice(input.settingsVoice, input.installed);
	if (fromSettings) return { engine: "system", voice: fromSettings };

	const natural = input.installed ? pickNaturalSystemVoice(input.installed) : null;
	return { engine: "system", voice: natural ?? FALLBACK_SYSTEM_VOICE };
}

export interface ListSystemVoicesOptions {
	/** How long a caller waits for a first read. The read keeps going and fills the cache. */
	waitMs?: number;
	/** Disk cache of the parsed list. */
	cachePath?: string;
	/** Re-read in the background once the cache is older than this. */
	maxAgeMs?: number;
	/** Test seams. */
	platform?: string;
	read?: () => Promise<string>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const refreshing = new Map<string, Promise<SystemVoice[] | null>>();

function readSayVoiceList(): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("say", ["-v", "?"], { timeout: 300_000 }, (err, stdout) =>
			err ? reject(err) : resolve(String(stdout)),
		);
		// Never keep the TUI process alive for this.
		child.unref();
	});
}

function loadVoiceCache(path: string): { savedAt: number; voices: SystemVoice[] } | null {
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (
			typeof data?.savedAt === "number" &&
			Array.isArray(data?.voices) &&
			data.voices.length > 0
		) {
			return data;
		}
	} catch {}
	return null;
}

function refreshVoiceCache(
	path: string,
	read: () => Promise<string>,
): Promise<SystemVoice[] | null> {
	const running = refreshing.get(path);
	if (running) return running;
	const job = read()
		.then((out) => {
			const voices = parseSayVoiceList(out);
			if (voices.length === 0) return null;
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, JSON.stringify({ savedAt: Date.now(), voices }));
			} catch {}
			return voices;
		})
		.catch(() => null)
		.finally(() => refreshing.delete(path));
	refreshing.set(path, job);
	return job;
}

/**
 * Installed macOS voices. `say -v '?'` can take over a minute on a busy Mac,
 * so the parsed list is cached on disk and refreshed in the background.
 * Resolves to null off macOS, or when there is no cache yet and the first
 * read does not finish within `waitMs`; callers must treat null as unknown.
 */
export async function listInstalledSystemVoices(
	options: ListSystemVoicesOptions = {},
): Promise<SystemVoice[] | null> {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return null;
	// Resolved per call, not at module load, so EIGHT_HOME and a test HOME set
	// after import are honoured.
	const path = options.cachePath ?? join(resolveHome(), ".8gent", "cache", "system-voices.json");
	const read = options.read ?? readSayVoiceList;
	const cached = loadVoiceCache(path);
	if (cached) {
		if (Date.now() - cached.savedAt > (options.maxAgeMs ?? WEEK_MS)) {
			void refreshVoiceCache(path, read);
		}
		return cached.voices;
	}
	const fresh = refreshVoiceCache(path, read);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), options.waitMs ?? 3000);
		timer.unref?.();
	});
	const result = await Promise.race([fresh, timeout]);
	clearTimeout(timer);
	return result;
}
