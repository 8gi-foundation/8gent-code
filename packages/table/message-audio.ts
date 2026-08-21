/**
 * Table message narration - file layout, path shape, and the loopback-only
 * HTTP handler that serves the bytes.
 *
 * Mirrors packages/daemon/huddle-stage.ts's handleStageHttp for a live huddle
 * turn's wav, but message narration is scoped to a single persisted message
 * rather than a huddle+turn, so the URL shape collapses one segment:
 *
 *   huddle turn:  /huddle/<huddleId>/audio/<file>   (daemon)
 *                 /huddle/audio/<huddleId>/<file>   (relay proxy, rewritten)
 *   message:      /table/audio/<messageId>/<file>   (daemon AND relay proxy -
 *                                                     identical strings, so no
 *                                                     field rewrite is needed
 *                                                     on the wire)
 *
 * The value stored in messages.audio_url IS this daemon-local path, and the
 * relay's GET /table/audio/{message_id}/{file_name} proxy (server.py) forwards
 * to the exact same path on the daemon over loopback - one string, two hops,
 * no rewrite step, unlike huddle:speak's audioUrl which does need one.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Root directory for all message narration files: ~/.8gent/table/audio/. */
export function messageAudioRoot(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "table", "audio");
}

/** Per-message narration directory, created on demand. */
export function messageAudioDir(messageId: string): string {
	return path.join(messageAudioRoot(), messageId);
}

/** Ensure the per-message directory exists and return it. */
export function prepareMessageAudioDir(messageId: string): string {
	const dir = messageAudioDir(messageId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The daemon-local (and relay-public) URL for one narration file. */
export function messageAudioUrl(messageId: string, fileName = "narration.wav"): string {
	return `/table/audio/${messageId}/${fileName}`;
}

/** The messageId/file charset a URL segment must match - no traversal, no
 *  surprises. Kept in one place so the daemon route and the routes-layer
 *  audioUrl validator (table-routes.ts) agree on exactly the same shape. */
export const MESSAGE_AUDIO_URL_RE = /^\/table\/audio\/([A-Za-z0-9_]+)\/([A-Za-z0-9._-]+)$/;

const MIME: Record<string, string> = {
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
};

/**
 * Serve GET /table/audio/<messageId>/<file>. Returns null when the path is
 * not ours, so the gateway falls through to the next handler - same contract
 * as handleStageHttp. SECURITY: both path segments are validated against
 * MESSAGE_AUDIO_URL_RE before touching the filesystem, and the resolved file
 * must live directly under that messageId's own directory (no "..", enforced
 * by the regex's charset already excluding "/").
 */
export function handleTableAudioHttp(url: URL): Response | null {
	const m = MESSAGE_AUDIO_URL_RE.exec(url.pathname);
	if (!m) return null;
	const [, messageId, file] = m;
	const filePath = path.join(messageAudioDir(messageId), file);
	if (!existsSync(filePath)) return new Response("not found", { status: 404 });
	const ext = file.slice(file.lastIndexOf("."));
	return new Response(readFileSync(filePath), {
		headers: {
			"content-type": MIME[ext] ?? "application/octet-stream",
			"cache-control": "no-store",
		},
	});
}
