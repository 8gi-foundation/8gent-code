/**
 * Voice-out for the local-mode dispatch loop.
 *
 * When the daemon runs in local mode and the user sent the originating
 * message over Telegram, the agent's final reply is also spoken on the
 * Mac speakers via KittenTTS (preferred) or `say -v Daniel` (fallback).
 *
 * Wiring:
 *   - speakReplyLocally(text)  fire-and-forget; truncates to 800 chars.
 *   - installVoiceOutForBus({...})  subscribes to session:start +
 *     agent:stream. When EIGHT_VOICE_OUT_LOCAL=1 and the session's
 *     originating channel is "telegram", a final agent:stream is piped
 *     into speakReplyLocally().
 *
 * Env vars:
 *   - EIGHT_VOICE_OUT_LOCAL=1     opt-in. Default OFF for now; flip to
 *                                  ON once the smoke test passes on a
 *                                  Mac with KittenTTS available.
 *   - EIGHT_VOICE_OUT_VOICE       optional KittenTTS voice id, default
 *                                  expr-voice-2-m (neutral male).
 *
 * Why fire-and-forget: TTS synthesis on KittenTTS takes a few seconds
 * for ~800 chars. Blocking the agent reply on speech would also block
 * the Telegram text reply, defeating the point of having a transcript.
 * Speech failures are logged and silently dropped.
 *
 * Why no third-party paid TTS provider: hard rule
 * (feedback_kittentts_only). Local synthesis only.
 */

import type { EventBus } from "./events";

const SPEAK_LIMIT = 800;
const DEFAULT_VOICE = "expr-voice-2-m";
const FALLBACK_SAY_VOICE = "Daniel";

export interface VoiceOutSpawn {
	kill: () => void;
}

export interface VoiceOutDeps {
	/**
	 * Called once when the helper is asked to speak. Implementations
	 * should not block the caller (return after kicking off the work).
	 * Tests substitute a recording stub here.
	 */
	speak: (text: string, voice: string) => VoiceOutSpawn | Promise<VoiceOutSpawn>;
	/** Probe whether KittenTTS is installed. Tests can stub this. */
	hasKittenTTS: () => Promise<boolean>;
}

/** Default deps: real Bun.spawn calls. */
function defaultDeps(): VoiceOutDeps {
	return {
		hasKittenTTS: async () => {
			try {
				const proc = Bun.spawn(["python3", "-c", "import kittentts"], {
					stdout: "ignore",
					stderr: "ignore",
				});
				const code = await proc.exited;
				return code === 0;
			} catch {
				return false;
			}
		},
		speak: async (text, voice) => {
			// We re-probe per call to avoid caching a stale "kitten missing"
			// state across daemon restarts. The caller already gated on
			// EIGHT_VOICE_OUT_LOCAL so this is on the cold path only.
			const useKitten = await defaultDeps().hasKittenTTS();
			if (useKitten) {
				const outPath = `/tmp/eight-voice-out-${Date.now()}.wav`;
				const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
				const script = [
					"from kittentts import KittenTTS",
					'm = KittenTTS("KittenML/kitten-tts-nano-0.8")',
					`m.generate_to_file("${escaped}", "${outPath}", voice="${voice}")`,
					"import subprocess",
					`subprocess.run(["afplay", "${outPath}"])`,
					"import os",
					`os.remove("${outPath}")`,
				].join("; ");
				const proc = Bun.spawn(["python3", "-c", script], {
					stdout: "ignore",
					stderr: "ignore",
				});
				return {
					kill: () => {
						try {
							proc.kill();
						} catch {}
						try {
							Bun.spawn(["killall", "afplay"], { stdout: "ignore", stderr: "ignore" });
						} catch {}
					},
				};
			}
			// Fallback: macOS `say`. Daniel is a neutral male voice; Ava
			// is reserved for completion announcements elsewhere.
			const proc = Bun.spawn(["say", "-v", FALLBACK_SAY_VOICE, text.slice(0, SPEAK_LIMIT)], {
				stdout: "ignore",
				stderr: "ignore",
			});
			return {
				kill: () => {
					try {
						proc.kill();
					} catch {}
				},
			};
		},
	};
}

/**
 * Speak the given text on the local machine. Fire-and-forget; the
 * promise resolves after the helper has been kicked off, NOT after
 * playback completes. Returns the spawn handle for tests/cleanup.
 *
 * Truncates at SPEAK_LIMIT characters so a 4-minute monologue never
 * blocks the reply path.
 *
 * Honors EIGHT_VOICE_OUT_LOCAL: if unset/0, returns null without
 * invoking the helper. Honors EIGHT_VOICE_OUT_VOICE for the kitten
 * voice id.
 */
export async function speakReplyLocally(
	text: string,
	deps: VoiceOutDeps = defaultDeps(),
): Promise<VoiceOutSpawn | null> {
	if (process.env.EIGHT_VOICE_OUT_LOCAL !== "1") return null;
	if (!text) return null;
	const trimmed = text.slice(0, SPEAK_LIMIT);
	const voice = process.env.EIGHT_VOICE_OUT_VOICE || DEFAULT_VOICE;
	try {
		const handle = await deps.speak(trimmed, voice);
		return handle;
	} catch (err) {
		console.error("[voice-out] speak failed:", err);
		return null;
	}
}

export interface InstallVoiceOutOpts {
	bus: EventBus;
	/** Override deps for tests. */
	deps?: VoiceOutDeps;
	/**
	 * Channels considered "voice-eligible". Default: telegram only.
	 * The TUI-originated session never speaks reply text aloud because
	 * the user is already looking at the screen.
	 */
	channels?: string[];
}

export interface InstallVoiceOutHandle {
	uninstall: () => void;
	/** Number of sessions currently tracked as voice-eligible. */
	tracked: () => number;
}

/**
 * Subscribe to bus events so that any agent:stream final emitted for
 * a voice-eligible session is spoken locally.
 *
 * Idempotent: each call returns its own handle, so a daemon restart
 * never leaks listeners.
 */
export function installVoiceOutForBus(opts: InstallVoiceOutOpts): InstallVoiceOutHandle {
	const deps = opts.deps ?? defaultDeps();
	const channels = new Set(opts.channels ?? ["telegram"]);
	const sessionChannels = new Map<string, string>();

	const startId = opts.bus.on("session:start", (payload) => {
		if (!payload?.sessionId) return;
		sessionChannels.set(payload.sessionId, payload.channel);
	});

	const endId = opts.bus.on("session:end", (payload) => {
		if (!payload?.sessionId) return;
		sessionChannels.delete(payload.sessionId);
	});

	const streamId = opts.bus.on("agent:stream", (payload) => {
		if (!payload?.final) return;
		const sid = payload.sessionId;
		if (!sid) return;
		const channel = sessionChannels.get(sid);
		if (!channel || !channels.has(channel)) return;
		const text = payload.chunk ?? "";
		if (!text.trim()) return;
		// Fire-and-forget: do not await. Speech failures are logged
		// inside speakReplyLocally and never surface to the agent.
		void speakReplyLocally(text, deps);
	});

	return {
		uninstall: () => {
			opts.bus.off(startId);
			opts.bus.off(endId);
			opts.bus.off(streamId);
			sessionChannels.clear();
		},
		tracked: () => sessionChannels.size,
	};
}
