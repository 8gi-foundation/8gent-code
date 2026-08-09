/**
 * @8gent/telegram-bot - Voice mode
 *
 * `/voice on` makes replies arrive as a KittenTTS voice note alongside the
 * text. `/voice off` goes back to text only. The setting persists, because a
 * toggle that resets when the bridge restarts is not a mode, it is a coin flip.
 *
 * Three rules decide whether a given reply is actually spoken. All three have
 * to pass; any one of them failing is a normal outcome, not an error, and the
 * text has already landed either way.
 *
 * 1. The toggle is on.
 * 2. It is not quiet hours (21:00 to 08:30 local, per the Voice Experience
 *    Contract). Text still lands; audio waits for the morning.
 * 3. The reply is short enough to be worth hearing. A 600-word answer read
 *    aloud is a punishment, and KittenTTS truncates at 600 characters anyway,
 *    so a long reply becomes a voice note that stops mid-sentence. Better to
 *    stay silent and let him read it.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the toggle lives, so it survives a bridge restart. */
export const VOICE_STATE_PATH =
	process.env.EIGHT_TG_VOICE_STATE || join(homedir(), ".8gent", "telegram-voice.json");

/** The outbound TTS bridge. Local KittenTTS, never a hosted voice API. */
const KITTENTTS_BIN = join(homedir(), ".claude", "bin", "kittentts-telegram");

/**
 * Longest reply we will speak, in characters. `kittentts-telegram` hard-trims
 * at 600 and appends an ellipsis, so anything above this is guaranteed to be a
 * voice note that cuts off. 600 characters is roughly 40 seconds of speech.
 */
export const MAX_SPOKEN_CHARS = 600;

/** Quiet hours, local time. Inclusive of the start hour, exclusive of the end. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
export const QUIET_END_MINUTE = 30;

export interface VoiceState {
	enabled: boolean;
	updatedAt: string;
}

const DEFAULT_STATE: VoiceState = { enabled: false, updatedAt: "" };

/** Read the persisted toggle. A missing or corrupt file means off. */
export function readVoiceState(path: string = VOICE_STATE_PATH): VoiceState {
	if (!existsSync(path)) return { ...DEFAULT_STATE };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return {
			enabled: parsed?.enabled === true,
			updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/** Persist the toggle. Creates the directory if the daemon has never run here. */
export function writeVoiceState(enabled: boolean, path: string = VOICE_STATE_PATH): VoiceState {
	const state: VoiceState = { enabled, updatedAt: new Date().toISOString() };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	} catch (err) {
		console.error("[voice-mode] could not persist state:", err);
	}
	return state;
}

/** True during 21:00-08:30 local. */
export function isQuietHours(now: Date = new Date()): boolean {
	const h = now.getHours();
	const m = now.getMinutes();
	if (h >= QUIET_START_HOUR) return true;
	if (h < QUIET_END_HOUR) return true;
	if (h === QUIET_END_HOUR && m < QUIET_END_MINUTE) return true;
	return false;
}

/**
 * Reduce a Markdown reply to something worth hearing: no fences, no bullets,
 * no link syntax, no runs of whitespace. Returns "" when there is nothing left
 * to say, which is the correct outcome for a reply that was only a code block.
 */
export function speakableText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^[\s>*-]+/gm, " ")
		.replace(/[*_#]+/g, "")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export type VoiceSkipReason =
	| "spoken"
	| "voice-mode-off"
	| "quiet-hours"
	| "too-long"
	| "nothing-to-say";

export interface VoiceDecision {
	speak: boolean;
	reason: VoiceSkipReason;
	text: string;
}

/**
 * Decide whether this reply gets spoken, and return the text that would be
 * spoken. Pure - no I/O, no side effects - so the policy is testable without a
 * Telegram token or a working audio stack.
 */
export function decideVoice(
	markdown: string,
	opts: { enabled: boolean; now?: Date; maxChars?: number },
): VoiceDecision {
	const max = opts.maxChars ?? MAX_SPOKEN_CHARS;
	const text = speakableText(markdown);
	if (!opts.enabled) return { speak: false, reason: "voice-mode-off", text };
	if (text.length === 0) return { speak: false, reason: "nothing-to-say", text };
	if (isQuietHours(opts.now ?? new Date())) return { speak: false, reason: "quiet-hours", text };
	if (text.length > max) return { speak: false, reason: "too-long", text };
	return { speak: true, reason: "spoken", text };
}

/**
 * Send a voice note.
 *
 * `kittentts-telegram` sources `~/.claude/.env` and posts to the
 * `TELEGRAM_CHAT_ID` it finds there. That is a second, independent destination
 * from the bridge's own allowlist, so before invoking it we require the caller
 * to assert which chat it believes it is replying to, and refuse when the two
 * disagree. Without that check, turning voice mode on would be a way to route
 * audio to a chat the bridge would never have sent text to.
 */
export async function sendVoiceNote(opts: {
	text: string;
	voice: string;
	expectedChatId: string;
	caption?: string;
	bin?: string;
	resolveConfiguredChatId?: () => string | null;
}): Promise<{ sent: boolean; reason: string }> {
	const bin = opts.bin ?? KITTENTTS_BIN;
	if (!existsSync(bin)) return { sent: false, reason: "kittentts-telegram not installed" };

	const configured = (opts.resolveConfiguredChatId ?? readConfiguredChatId)();
	if (!configured) return { sent: false, reason: "no TELEGRAM_CHAT_ID configured for TTS" };
	if (configured !== opts.expectedChatId) {
		// Deliberately loud: this is the allowlist boundary, not a config nit.
		console.error(
			"[voice-mode] refusing to speak - TTS destination does not match the bridge chat",
		);
		return { sent: false, reason: "TTS chat does not match the bridge allowlist" };
	}

	const args = ["--voice", opts.voice];
	if (opts.caption) args.push("--caption", opts.caption);

	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		child.on("error", (err) => resolve({ sent: false, reason: String(err) }));
		child.on("close", (code) =>
			resolve(
				code === 0
					? { sent: true, reason: "ok" }
					: { sent: false, reason: stderr.trim().slice(-200) || `exit ${code}` },
			),
		);
		child.stdin?.end(opts.text);
	});
}

/**
 * Read TELEGRAM_CHAT_ID out of `~/.claude/.env` without sourcing the file.
 * Only the chat id line is parsed; nothing else in that file is read, so no
 * token is ever loaded into this process or its logs.
 */
export function readConfiguredChatId(
	envPath: string = join(homedir(), ".claude", ".env"),
): string | null {
	if (!existsSync(envPath)) return null;
	try {
		for (const line of readFileSync(envPath, "utf-8").split("\n")) {
			const m = line.match(/^\s*(?:export\s+)?TELEGRAM_CHAT_ID\s*=\s*["']?([^"'#\s]+)/);
			if (m) return m[1];
		}
	} catch {
		// Unreadable env file is a "cannot speak", not a crash.
	}
	return null;
}
