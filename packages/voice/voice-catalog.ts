/**
 * 8gent Code - Voice catalog
 *
 * Answers one question: which voices can this machine speak with right now?
 *
 * - Kitten and Supertonic voices are fixed by the model (ENGINE_VOICES). They
 *   are listed only when the Python package imports; otherwise the engine is
 *   omitted and `unavailable` carries a one-line reason for the UI.
 * - macOS voices are parsed from `say -v '?'` at runtime. The installed set
 *   varies per machine (184 on the owner's), so nothing is hardcoded. Apple's
 *   novelty voices (Bells, Zarvox, ...) are flagged so the picker can sort
 *   them into a "Fun" group at the end.
 *
 * The catalog is cached per process. `previewVoice()` speaks one fixed
 * sentence through the real engine for the given voice, interrupting any
 * previous preview, so the picker can let the user hear a voice before
 * choosing it.
 */

import type { TTSEngineName } from "../settings/schema.js";
import { ENGINE_DEFAULT_VOICES, ENGINE_VOICES } from "../settings/voice.js";
import {
	KittenTTSProvider,
	MacOSTTSProvider,
	SupertonicTTSProvider,
	TTSEngine,
	type TTSProcess,
	type TTSProvider,
	getTTSEngine,
} from "./tts-engine.js";

// ============================================
// Types
// ============================================

export type VoiceGroupId = TTSEngineName | "fun";

export interface VoiceEntry {
	/** Engine that speaks this voice. */
	engine: TTSEngineName;
	/** Name handed to the engine (`say -v <id>` for macOS, model voice otherwise). */
	id: string;
	/** Name shown in the picker. For macOS the locale suffix is moved to the hint. */
	name: string;
	/** Gender or style where the engine documents it; the language for macOS. */
	hint: string;
	/** Language code for macOS voices (e.g. "en_GB"), null for the neural engines. */
	language: string | null;
	/** Apple novelty voice; sorts into the "Fun" group. */
	novelty: boolean;
}

export interface VoiceGroup {
	id: VoiceGroupId;
	label: string;
	voices: VoiceEntry[];
}

export interface VoiceCatalog {
	/** Groups in display order, each with at least one voice. */
	groups: VoiceGroup[];
	/** Engines that were probed and are not usable here, with a one-line reason. */
	unavailable: Array<{ engine: TTSEngineName; reason: string }>;
	/** Recommended default: the documented fallback of the first available engine. */
	recommended: { engine: TTSEngineName; id: string } | null;
}

export interface VoiceCatalogOptions {
	/** Availability probe per engine (tests inject fakes). */
	probe?: (engine: TTSEngineName) => Promise<{ available: boolean; reason: string | null }>;
	/** Output of `say -v '?'` (tests pass a fixture). */
	sayOutput?: () => Promise<string | null>;
}

export const GROUP_LABELS: Record<VoiceGroupId, string> = {
	kitten: "Kitten, local neural, fastest",
	supertonic: "Supertonic, local neural, many languages",
	macos: "Built-in macOS",
	fun: "Fun",
};

export const PREVIEW_SENTENCE = "Hi, I am 8gent. This is how I will sound.";

// ============================================
// Fixed hints for the neural engines
// ============================================

/**
 * What the engines document about their voices. KittenTTS 0.8 ships four
 * male and four female voices; Supertonic 3 names its voices by gender.
 * The words after the gender are the short descriptions the onboarding
 * flow has used since the voices were first offered.
 */
const KITTEN_HINTS: Record<string, string> = {
	Bella: "female, warm and clear",
	Jasper: "male, crisp and technical",
	Luna: "female, soft and creative",
	Bruno: "male, warm and authoritative",
	Rosie: "female, bright and energetic",
	Hugo: "male, neutral and steady",
	Kiki: "female, light and friendly",
	Leo: "male, rich and expressive",
};

function supertonicHint(id: string): string {
	return id.startsWith("F") ? "female" : "male";
}

// ============================================
// macOS `say -v '?'` parsing
// ============================================

/**
 * Apple's "Novelty" category. `say -v '?'` does not expose the category,
 * so the names are classified here. This is a classification of Apple's
 * own grouping, not a list of voices to offer: the voices themselves always
 * come from the parsed output and any name not installed is never shown.
 */
const NOVELTY_NAMES = new Set([
	"Bad News",
	"Bahh",
	"Bells",
	"Boing",
	"Bubbles",
	"Cellos",
	"Good News",
	"Jester",
	"Organ",
	"Superstar",
	"Trinoids",
	"Whisper",
	"Wobble",
	"Zarvox",
]);

/**
 * One line of `say -v '?'` looks like:
 *   Daniel              en_GB    # Hello! My name is Daniel.
 *   Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
 *   Bad News            en_US    # Hello! My name is Bad News.
 * The name may contain spaces and nested parentheses; the language code is
 * the first token shaped like `xx_YY` (also `ar_001`) followed by `#`.
 */
const SAY_LINE = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,3})\s+#\s*(.*)$/;

export function isNoveltyVoice(name: string): boolean {
	return NOVELTY_NAMES.has(baseName(name));
}

function baseName(id: string): string {
	const paren = id.indexOf(" (");
	return paren === -1 ? id.trim() : id.slice(0, paren).trim();
}

function localeSuffix(id: string): string | null {
	const paren = id.indexOf(" (");
	if (paren === -1) return null;
	const inner = id.slice(paren + 2, id.endsWith(")") ? -1 : undefined).trim();
	return inner.length > 0 ? inner : null;
}

function languageLabel(code: string): string {
	try {
		const tag = code.replace("_", "-");
		const label = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
		if (label && label !== tag) return label;
	} catch {
		// Older runtimes without Intl.DisplayNames fall through to the code.
	}
	return code;
}

/** Parse `say -v '?'` output into macOS voice entries. Exported for tests. */
export function parseSayVoices(output: string): VoiceEntry[] {
	const entries: VoiceEntry[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const m = SAY_LINE.exec(line);
		if (!m) continue;
		const id = m[1].trim();
		const language = m[2];
		entries.push({
			engine: "macos",
			id,
			name: baseName(id),
			hint: localeSuffix(id) ?? languageLabel(language),
			language,
			novelty: isNoveltyVoice(id),
		});
	}
	return entries;
}

async function readSayVoices(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const proc = Bun.spawn(["say", "-v", "?"], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? text : null;
	} catch {
		return null;
	}
}

// ============================================
// Availability probes
// ============================================

const PROBE_PROVIDERS: Record<TTSEngineName, () => TTSProvider> = {
	kitten: () => new KittenTTSProvider(),
	supertonic: () => new SupertonicTTSProvider(),
	macos: () => new MacOSTTSProvider(),
};

async function probeEngine(
	engine: TTSEngineName,
): Promise<{ available: boolean; reason: string | null }> {
	const provider = PROBE_PROVIDERS[engine]();
	try {
		const available = await provider.isAvailable();
		const reason = available ? null : provider.unavailableReason?.() ?? "not available";
		return { available, reason: available ? null : humanReason(engine, reason) };
	} catch (err) {
		return { available: false, reason: humanReason(engine, String(err)) };
	} finally {
		provider.dispose?.();
	}
}

function humanReason(engine: TTSEngineName, detail: string | null): string {
	if (engine === "kitten") return "KittenTTS not installed";
	if (engine === "supertonic") return "Supertonic not installed";
	return detail ?? "macOS say not available";
}

// ============================================
// Catalog
// ============================================

const ENGINE_ORDER: TTSEngineName[] = ["kitten", "supertonic", "macos"];

function neuralEntries(engine: "kitten" | "supertonic"): VoiceEntry[] {
	return ENGINE_VOICES[engine].map((id) => ({
		engine,
		id,
		name: id,
		hint: engine === "kitten" ? (KITTEN_HINTS[id] ?? "") : supertonicHint(id),
		language: null,
		novelty: false,
	}));
}

function byName(a: VoiceEntry, b: VoiceEntry): number {
	return a.name.localeCompare(b.name) || a.hint.localeCompare(b.hint);
}

/** Build the catalog with injectable probes. Not cached; see getVoiceCatalog. */
export async function buildVoiceCatalog(options: VoiceCatalogOptions = {}): Promise<VoiceCatalog> {
	const probe = options.probe ?? probeEngine;
	const sayOutput = options.sayOutput ?? readSayVoices;
	const groups: VoiceGroup[] = [];
	const unavailable: VoiceCatalog["unavailable"] = [];
	const fun: VoiceEntry[] = [];

	const results = await Promise.all(ENGINE_ORDER.map((engine) => probe(engine)));
	for (let i = 0; i < ENGINE_ORDER.length; i++) {
		const engine = ENGINE_ORDER[i];
		const result = results[i];
		if (!result.available) {
			unavailable.push({ engine, reason: result.reason ?? humanReason(engine, null) });
			continue;
		}
		if (engine === "macos") {
			const text = await sayOutput();
			const parsed = text ? parseSayVoices(text) : [];
			const real = parsed.filter((v) => !v.novelty).sort(byName);
			fun.push(...parsed.filter((v) => v.novelty).sort(byName));
			if (real.length > 0) groups.push({ id: "macos", label: GROUP_LABELS.macos, voices: real });
			else unavailable.push({ engine, reason: "say -v '?' listed no voices" });
			continue;
		}
		groups.push({ id: engine, label: GROUP_LABELS[engine], voices: neuralEntries(engine) });
	}
	if (fun.length > 0) groups.push({ id: "fun", label: GROUP_LABELS.fun, voices: fun });

	const first = groups.find((g) => g.id !== "fun");
	const recommended = first
		? { engine: first.voices[0].engine, id: ENGINE_DEFAULT_VOICES[first.voices[0].engine].orchestrator }
		: null;
	return { groups, unavailable, recommended };
}

let cached: Promise<VoiceCatalog> | null = null;

/** The voices this machine can speak with, cached for the life of the process. */
export function getVoiceCatalog(): Promise<VoiceCatalog> {
	if (!cached) {
		cached = buildVoiceCatalog().catch((err) => {
			cached = null;
			throw err;
		});
	}
	return cached;
}

/** Drop the cache (tests, or after installing an engine). */
export function resetVoiceCatalog(): void {
	cached = null;
}

// ============================================
// Preview
// ============================================

const previewEngines = new Map<TTSEngineName, TTSEngine>();
let currentPreview: TTSProcess | null = null;

/**
 * One TTSEngine per engine name so a preview speaks through the engine the
 * voice belongs to, not the one settings prefer. The shared singleton is
 * reused when it already prefers that engine, so the Kitten worker (and its
 * model load) is not paid twice.
 */
function engineFor(engine: TTSEngineName): TTSEngine {
	const shared = getTTSEngine();
	if (shared.getStatus().preferred === engine) return shared;
	let own = previewEngines.get(engine);
	if (!own) {
		own = new TTSEngine(engine);
		previewEngines.set(engine, own);
	}
	return own;
}

/**
 * Speak the preview sentence with `voice` on `engine`, interrupting any
 * preview still playing. Resolves once playback has started; the returned
 * process can be awaited or killed by the caller.
 */
export async function previewVoice(engine: TTSEngineName, voice: string): Promise<TTSProcess> {
	await stopPreview();
	const proc = await engineFor(engine).speak(PREVIEW_SENTENCE, { voice });
	currentPreview = proc;
	void proc.exited.then(() => {
		if (currentPreview === proc) currentPreview = null;
	});
	return proc;
}

/** Stop the preview that is playing, if any. */
export async function stopPreview(): Promise<void> {
	const proc = currentPreview;
	currentPreview = null;
	if (proc) proc.kill();
	await Promise.all([...previewEngines.values()].map((e) => e.interrupt().catch(() => {})));
	await getTTSEngine()
		.interrupt()
		.catch(() => {});
}
