/**
 * Push-to-talk state machine (pure, no mic, no Ink).
 *
 * Mode is TOGGLE: press the key to open the mic, press it again to stop.
 * Terminals deliver key presses but not key releases, so a true hold-to-talk
 * cannot be done reliably in Ink; toggle is the honest choice.
 *
 * idle -> recording -> transcribing -> inserted -> idle
 *                  \-> error -> idle
 *
 * The mic is only ever opened by an explicit key press, and only when the
 * user turned the setting on (voice.inputEnabled, default off).
 */

export type PttPhase = "idle" | "recording" | "transcribing" | "inserted" | "error";

export type PttEvent =
	| { type: "key"; enabled: boolean; ttsActive?: boolean }
	| { type: "recorded" }
	| { type: "transcript"; text: string; echo?: boolean }
	| { type: "failure"; message: string }
	| { type: "ack" };

export interface PttState {
	phase: PttPhase;
	/** Transcript waiting in the prompt for the user to edit or send. */
	text: string;
	/** Message for the user when phase is "error" or the key was refused. */
	message: string | null;
	/** What the key press asked the caller to do. */
	action: "none" | "start" | "stop";
}

export const PTT_KEY_LABEL = "Ctrl+R";

export const PTT_DISABLED_MESSAGE =
	"Voice input is off. Turn it on with /voice input on, then press Ctrl+R to talk and Ctrl+R again to stop.";

export const PTT_TTS_MESSAGE = "Wait for the spoken reply to finish, then press Ctrl+R.";
export const PTT_ECHO_MESSAGE = "Dropped: the mic overlapped with spoken output. Try again.";
export const PTT_NO_SPEECH_MESSAGE = "No speech heard. Try again.";

/** A recording ending this soon after TTS stopped is treated as echo. */
export const TTS_ECHO_GUARD_MS = 1000;

export const PTT_INITIAL: PttState = { phase: "idle", text: "", message: null, action: "none" };

export function pttReduce(state: PttState, event: PttEvent): PttState {
	switch (event.type) {
		case "key":
			// Privacy: an open mic can ALWAYS be stopped, even if the setting
			// was turned off mid-recording.
			if (state.phase === "recording") {
				return { ...state, action: "stop", message: null };
			}
			if (!event.enabled) {
				return { ...PTT_INITIAL, message: PTT_DISABLED_MESSAGE };
			}
			if (event.ttsActive && state.phase !== "transcribing") {
				// Never open the mic while we are speaking (echo / self-hearing).
				return { phase: "idle", text: "", message: PTT_TTS_MESSAGE, action: "none" };
			}
			if (state.phase === "transcribing") {
				// Busy: a second press must not start a second capture.
				return { ...state, action: "none" };
			}
			// idle, inserted, error: a fresh capture starts clean.
			return { phase: "recording", text: "", message: null, action: "start" };
		case "recorded":
			return state.phase === "recording"
				? { ...state, phase: "transcribing", action: "none" }
				: state;
		case "transcript": {
			if (state.phase !== "transcribing" && state.phase !== "recording") return state;
			const text = event.text.trim();
			if (!text) {
				return { phase: "error", text: "", message: PTT_NO_SPEECH_MESSAGE, action: "none" };
			}
			if (event.echo) {
				return { phase: "error", text: "", message: PTT_ECHO_MESSAGE, action: "none" };
			}
			return { phase: "inserted", text, message: null, action: "none" };
		}
		case "failure":
			return { phase: "error", text: "", message: event.message, action: "none" };
		case "ack":
			return PTT_INITIAL;
	}
}

/**
 * Tracks whether this process is speaking (TTS), so the mic never opens over
 * it and a transcript that overlapped speech is dropped as echo. Module-level
 * because speech is fired from several places; clock is injectable for tests.
 */
export interface TtsTracker {
	active: number;
	lastEndedAt: number;
}

export function createTtsTracker(): TtsTracker {
	return { active: 0, lastEndedAt: 0 };
}

export const ttsTracker: TtsTracker = createTtsTracker();

export function ttsStarted(t: TtsTracker = ttsTracker): void {
	t.active += 1;
}

export function ttsEnded(t: TtsTracker = ttsTracker, now: number = Date.now()): void {
	t.active = Math.max(0, t.active - 1);
	t.lastEndedAt = now;
}

/** Mark speech for the life of a spawned process or a promise of its exit. */
export function trackTts(
	proc: { on?: (e: string, cb: () => void) => unknown; exited?: Promise<unknown> },
	t: TtsTracker = ttsTracker,
): void {
	ttsStarted(t);
	let done = false;
	const end = () => {
		if (done) return;
		done = true;
		ttsEnded(t);
	};
	if (proc.on) {
		proc.on("close", end);
		proc.on("exit", end);
		proc.on("error", end);
	} else if (proc.exited) {
		proc.exited.then(end, end);
	} else {
		end();
	}
}

export function isTtsActive(t: TtsTracker = ttsTracker): boolean {
	return t.active > 0;
}

/** True when a recording [startedAt, endedAt] overlapped speech or ended within the guard of it. */
export function recordingOverlappedTts(
	startedAt: number,
	endedAt: number,
	t: TtsTracker = ttsTracker,
	guardMs: number = TTS_ECHO_GUARD_MS,
): boolean {
	if (t.active > 0) return true;
	if (t.lastEndedAt === 0) return false;
	return t.lastEndedAt >= startedAt || endedAt - t.lastEndedAt < guardMs;
}
