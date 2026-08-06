/**
 * 8gent Huddle Phase 1 - voice selection and narration (spec section 5.2-5.4).
 *
 * Voice Experience Contract, point 2: voice is DECLARED identity, never
 * inferred. The officer code picks the voice. There is no keyword routing, no
 * random pool, and no inference from message content anywhere in this file.
 * Same officer, same voice, every huddle, forever.
 *
 * Both maps below already existed in the tree and are reused verbatim:
 *   - Supertonic style, from deck2video.py::ST_VOICE
 *   - macOS `say` name, from TableVoice.swift::voice(for:)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface OfficerVoice {
	/** macOS `say` voice name - the fallback path and the TableVoice identity. */
	say: string;
	/** Supertonic style id - the primary path. */
	supertonic: string;
}

/** The ONLY source of voice identity. Keyed by officer code. */
export const VOICES: Readonly<Record<string, OfficerVoice>> = {
	"8EO": { say: "Ava", supertonic: "F3" },
	"8TO": { say: "Daniel", supertonic: "M3" },
	"8PO": { say: "Samantha", supertonic: "F1" },
	"8DO": { say: "Moira", supertonic: "F2" },
	"8SO": { say: "Karen", supertonic: "F3" },
	"8CO": { say: "Diego", supertonic: "M2" },
	"8MO": { say: "Zara", supertonic: "F4" },
	"8GO": { say: "Alex", supertonic: "M2" },
};

/** James's own turns are NEVER synthesised - zen-gen plays his real recording
 *  back (spec 6.1). This entry exists only so a headless/quiet-hours bake has a
 *  deterministic stand-in when no dictation wav was captured. */
export const HUMAN_VOICE: OfficerVoice = { say: "Daniel", supertonic: "M4" };

export function voiceFor(code: string): OfficerVoice {
	return VOICES[code.toUpperCase()] ?? HUMAN_VOICE;
}

// ── Quiet hours (spec 5.4) ────────────────────────────────────────────────

export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
export const QUIET_END_MINUTE = 30;

/**
 * 21:00-08:30 local. Pure over the Date passed in, so tests never depend on
 * when they run.
 *
 * The rule as it applies here: quiet hours suppress AMBIENT audio. A huddle
 * James explicitly opened and is watching is not ambient, so the daemon passes
 * `interactive: true` and narration proceeds. An AUTOMATIC huddle (a nightly
 * factory round) is ambient: it still renders slides and still bakes a
 * watchable artifact, it just does not make noise in the house at 3am.
 */
export function inQuietHours(now: Date): boolean {
	const h = now.getHours();
	const m = now.getMinutes();
	if (h >= QUIET_START_HOUR) return true;
	if (h < QUIET_END_HOUR) return true;
	return h === QUIET_END_HOUR && m < QUIET_END_MINUTE;
}

// ── Narration ─────────────────────────────────────────────────────────────

const SUPERTONIC_CANDIDATES = [
	`${process.env.HOME}/.pyenv/shims/supertonic`,
	"/opt/homebrew/bin/supertonic",
	"/usr/local/bin/supertonic",
];

export function findSupertonic(): string | null {
	for (const p of SUPERTONIC_CANDIDATES) if (existsSync(p)) return p;
	const which = spawnSync("which", ["supertonic"], { encoding: "utf8" });
	const found = which.stdout?.trim();
	return found && existsSync(found) ? found : null;
}

/**
 * Text an officer's reply into something worth SPEAKING.
 *
 * Officers reply with prose plus markers. The markers are already stripped by
 * resolveSlide; this removes the residue that sounds wrong read aloud (list
 * bullets, stray backticks, verify's parenthetical provenance) without changing
 * a single word of substance. Pure.
 */
export function speechText(text: string, maxChars = 480): string {
	const cleaned = text
		.replace(/\(verified:[^)]*\)/g, "")
		.replace(/\[CLAIM STRIPPED:[^\]]*\]/g, "")
		.replace(/`+/g, "")
		.replace(/^[\s>*-]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxChars) return cleaned;
	// Cut at the last sentence end inside the budget so narration never stops
	// mid-clause.
	const cut = cleaned.slice(0, maxChars);
	const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
	return stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd();
}

/** Deterministic reading-time estimate, identical to floor.ts's. Used when
 *  audio was not synthesised (quiet hours, or no TTS on the box). */
export function estimateReadingMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	if (words === 0) return 3500;
	return Math.min(20_000, Math.max(3500, Math.round((words / 2.6) * 1000)));
}

/** Real duration of a wav, via ffprobe. Returns null when it cannot be read. */
export function probeDurationMs(wavPath: string): number | null {
	const r = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath],
		{ encoding: "utf8" },
	);
	const secs = Number.parseFloat((r.stdout ?? "").trim());
	return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
}

export interface NarrationResult {
	/** Absolute path to the wav, or null when nothing was synthesised. */
	audioPath: string | null;
	/** Measured duration when synthesised, else the deterministic estimate. */
	durationMs: number;
	/** Why there is no audio, when there is none. */
	skipped?: "quiet_hours" | "no_tts" | "tts_failed" | "empty_text";
}

export interface NarrateOptions {
	text: string;
	voice: OfficerVoice;
	outPath: string;
	/** An explicitly-opened huddle is interactive and speaks during quiet hours. */
	interactive: boolean;
	now?: Date;
	steps?: number;
}

/**
 * Synthesise one turn's narration. Never throws - narration is a nice-to-have
 * on top of a correct slide, and a TTS failure must never stall the floor or
 * lose a turn. Every failure path returns a usable durationMs so the deck still
 * has correct timing and can be narrated later.
 */
export function narrateTurn(opts: NarrateOptions): NarrationResult {
	const text = speechText(opts.text);
	if (!text) return { audioPath: null, durationMs: estimateReadingMs(""), skipped: "empty_text" };

	const estimate = estimateReadingMs(text);
	if (!opts.interactive && inQuietHours(opts.now ?? new Date())) {
		return { audioPath: null, durationMs: estimate, skipped: "quiet_hours" };
	}

	const bin = findSupertonic();
	if (!bin) return { audioPath: null, durationMs: estimate, skipped: "no_tts" };

	const r = spawnSync(
		bin,
		["tts", text, "-o", opts.outPath, "--voice", opts.voice.supertonic, "--steps", String(opts.steps ?? 8)],
		{ encoding: "utf8", timeout: 120_000 },
	);
	if (r.status !== 0 || !existsSync(opts.outPath)) {
		return { audioPath: null, durationMs: estimate, skipped: "tts_failed" };
	}
	return { audioPath: opts.outPath, durationMs: probeDurationMs(opts.outPath) ?? estimate };
}
