/**
 * Table message narration - ON DEMAND, real-time, never persisted.
 *
 * James (2026-08-21), correcting the earlier per-message audio_url direction:
 * a "play this message aloud" button belongs on EVERY Table message, not just
 * one curated narration. It synthesises from the message's live content and
 * plays back immediately - no DB row, no file under ~/.8gent/table/audio/...
 * surviving past the request. That persisted path (message-audio.ts,
 * attachAudio) stays exactly as it is for the one message that already has a
 * curated narration; this module is the separate, general affordance.
 *
 * Reuses huddle-voice.ts's Supertonic call VERBATIM - narrateTurn(), voiceFor(),
 * HUMAN_VOICE. No second TTS engine, no reimplementation of the synthesis
 * path: the only new code here is (1) picking a voice from a MESSAGE's author
 * instead of a huddle turn's officer, and (2) synthesising to a throwaway
 * temp directory that is removed in a `finally` before the HTTP response ever
 * leaves this function - the temp file exists only for the duration of the
 * synthesis + read, never past it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HUMAN_VOICE, type OfficerVoice, narrateTurn, type NarrationResult, voiceFor } from "./huddle-voice.js";
import { TableAuthError, type Message, type ParticipantId } from "./types.js";
import type { TableStore } from "./store.js";

/**
 * Which voice narrates a message, from its author - declared identity, never
 * inferred, same rule huddle-voice.ts documents: an agent author's own
 * officer code selects its huddle voice (voiceFor falls back to HUMAN_VOICE
 * for an unknown code); any human author gets HUMAN_VOICE, the same stand-in
 * huddle narration already uses for James's own turns.
 */
export function voiceForAuthor(authorId: ParticipantId, voiceFor: (code: string) => OfficerVoice): OfficerVoice {
	if (authorId.startsWith("agent:")) {
		return voiceFor(authorId.slice("agent:".length));
	}
	return HUMAN_VOICE;
}

export type SpeakFailureReason = "empty_text" | "no_tts" | "tts_failed";

export type SpeakResult =
	| { ok: true; bytes: Buffer; durationMs: number }
	| { ok: false; reason: SpeakFailureReason };

/** Injectable seam so tests can substitute a fake narrator instead of
 *  shelling out to the real supertonic binary on every run. */
export interface SynthesizeDeps {
	narrate: (opts: Parameters<typeof narrateTurn>[0]) => NarrationResult;
	voiceFor: (code: string) => OfficerVoice;
}

const defaultDeps: SynthesizeDeps = { narrate: narrateTurn, voiceFor };

/**
 * Synthesise one message's content to wav bytes, ephemeral end to end: a
 * fresh temp directory per call, removed in `finally` regardless of outcome,
 * so nothing survives past this function returning. Never throws - a TTS
 * failure is a result, not an exception (same contract narrateTurn itself
 * already documents).
 */
export async function synthesizeMessageSpeech(
	message: Pick<Message, "content" | "authorId">,
	deps: SynthesizeDeps = defaultDeps,
): Promise<SpeakResult> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "table-speak-"));
	try {
		const voice = voiceForAuthor(message.authorId, deps.voiceFor);
		const outPath = path.join(dir, "speak.wav");
		const result = deps.narrate({
			text: message.content,
			voice,
			outPath,
			// A click is an explicit, James-initiated request to hear this NOW -
			// interactive, exactly like an opened huddle - so quiet hours never
			// silently swallow an on-demand play.
			interactive: true,
		});
		if (!result.audioPath) {
			const reason: SpeakFailureReason = result.skipped === "empty_text" ? "empty_text" : "tts_failed";
			// "quiet_hours" cannot occur (interactive: true above); "no_tts" and
			// "tts_failed" both mean the daemon could not produce audio right now.
			return { ok: false, reason: result.skipped === "no_tts" ? "no_tts" : reason };
		}
		const bytes = readFileSync(result.audioPath);
		return { ok: true, bytes, durationMs: result.durationMs };
	} finally {
		// Ephemeral, always: the temp file/dir never survives this call, success
		// or failure alike.
		rmSync(dir, { recursive: true, force: true });
	}
}

/** messageId charset for the speak route - same discipline as every other
 *  Table URL segment validator in this package. */
export const SPEAK_URL_RE = /^\/table\/messages\/([A-Za-z0-9_]+)\/speak$/;

const FAILURE_STATUS: Record<SpeakFailureReason, number> = {
	empty_text: 422,
	no_tts: 503,
	tts_failed: 503,
};

/**
 * Serve POST /table/messages/<messageId>/speak. Returns null when the
 * method/path is not ours (gateway falls through), a Response otherwise -
 * same optional-handler contract as handleStageHttp / handleTableAudioHttp.
 *
 * Read authority mirrors channel:presence's own idiom exactly: listMessages
 * with viewerId is the SAME check every other Table read already enforces
 * (private channel, human:local not a member -> TableAuthError -> 403), not
 * a parallel rule invented here.
 */
export async function handleTableSpeakHttp(
	req: Request,
	url: URL,
	store: TableStore,
	deps?: SynthesizeDeps,
): Promise<Response | null> {
	if (req.method !== "POST") return null;
	const m = SPEAK_URL_RE.exec(url.pathname);
	if (!m) return null;
	const [, messageId] = m;

	const message = store.getMessage(messageId);
	if (!message || message.deletedAt != null) {
		return Response.json({ error: "message not found" }, { status: 404 });
	}
	try {
		store.listMessages(message.channelId, { limit: 1, viewerId: "human:local" });
	} catch (err) {
		if (err instanceof TableAuthError) {
			return Response.json({ error: "forbidden" }, { status: 403 });
		}
		return Response.json({ error: "message not found" }, { status: 404 });
	}

	const result = await synthesizeMessageSpeech(message, deps);
	if (!result.ok) {
		return Response.json({ error: result.reason }, { status: FAILURE_STATUS[result.reason] });
	}
	return new Response(new Uint8Array(result.bytes), {
		headers: {
			"content-type": "audio/wav",
			"cache-control": "no-store",
			"x-speech-duration-ms": String(result.durationMs),
		},
	});
}
