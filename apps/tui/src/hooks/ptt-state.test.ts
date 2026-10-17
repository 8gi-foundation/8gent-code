import { describe, expect, test } from "bun:test";
import {
	PTT_DISABLED_MESSAGE,
	PTT_ECHO_MESSAGE,
	PTT_INITIAL,
	PTT_NO_SPEECH_MESSAGE,
	PTT_TTS_MESSAGE,
	type PttEvent,
	createTtsTracker,
	pttReduce,
	recordingOverlappedTts,
	trackTts,
	ttsEnded,
	ttsStarted,
} from "./ptt-state.js";

const run = (events: PttEvent[]) => events.reduce(pttReduce, PTT_INITIAL);

describe("push-to-talk state machine", () => {
	test("key press with the setting off never starts and says how to enable", () => {
		const s = run([{ type: "key", enabled: false }]);
		expect(s.phase).toBe("idle");
		expect(s.action).toBe("none");
		expect(s.message).toBe(PTT_DISABLED_MESSAGE);
	});

	test("idle -> recording on first press", () => {
		const s = run([{ type: "key", enabled: true }]);
		expect(s.phase).toBe("recording");
		expect(s.action).toBe("start");
	});

	test("second press while recording asks to stop", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "key", enabled: true },
		]);
		expect(s.phase).toBe("recording");
		expect(s.action).toBe("stop");
	});

	test("full path ends in inserted with trimmed text, then ack returns to idle", () => {
		const inserted = run([
			{ type: "key", enabled: true },
			{ type: "recorded" },
			{ type: "transcript", text: "  hello there  " },
		]);
		expect(inserted.phase).toBe("inserted");
		expect(inserted.text).toBe("hello there");
		expect(pttReduce(inserted, { type: "ack" })).toEqual(PTT_INITIAL);
	});

	test("a press while transcribing is ignored (no second capture)", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "recorded" },
			{ type: "key", enabled: true },
		]);
		expect(s.phase).toBe("transcribing");
		expect(s.action).toBe("none");
	});

	test("empty transcript is an error, not an empty insert", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "recorded" },
			{ type: "transcript", text: "   " },
		]);
		expect(s.phase).toBe("error");
		expect(s.text).toBe("");
	});

	test("no mic or no model failure surfaces its message and recovers on next press", () => {
		const failed = run([
			{ type: "key", enabled: true },
			{ type: "failure", message: "No microphone found" },
		]);
		expect(failed.phase).toBe("error");
		expect(failed.message).toBe("No microphone found");
		const again = pttReduce(failed, { type: "key", enabled: true });
		expect(again.phase).toBe("recording");
		expect(again.message).toBeNull();
	});

	test("stray events outside their phase are ignored", () => {
		expect(pttReduce(PTT_INITIAL, { type: "recorded" })).toBe(PTT_INITIAL);
		expect(pttReduce(PTT_INITIAL, { type: "transcript", text: "x" })).toBe(PTT_INITIAL);
	});
});

describe("privacy: an open mic can always be stopped", () => {
	test("setting turned off while recording still yields action stop", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "key", enabled: false },
		]);
		expect(s.phase).toBe("recording");
		expect(s.action).toBe("stop");
	});
});

describe("echo guard (TTS vs mic)", () => {
	test("key press while TTS is speaking does not start recording", () => {
		const s = run([{ type: "key", enabled: true, ttsActive: true }]);
		expect(s.phase).toBe("idle");
		expect(s.action).toBe("none");
		expect(s.message).toBe(PTT_TTS_MESSAGE);
	});

	test("TTS starting mid-recording does not block stopping", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "key", enabled: true, ttsActive: true },
		]);
		expect(s.action).toBe("stop");
	});

	test("transcript flagged as echo is dropped, not inserted", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "recorded" },
			{ type: "transcript", text: "the assistant said this", echo: true },
		]);
		expect(s.phase).toBe("error");
		expect(s.text).toBe("");
		expect(s.message).toBe(PTT_ECHO_MESSAGE);
	});

	test("tracker: overlap, 1 s tail, clear gap, and active speech", () => {
		const t = createTtsTracker();
		expect(recordingOverlappedTts(1000, 2000, t)).toBe(false);
		ttsStarted(t);
		expect(recordingOverlappedTts(1000, 2000, t)).toBe(true);
		ttsEnded(t, 1500);
		// TTS ended inside the recording
		expect(recordingOverlappedTts(1000, 2000, t)).toBe(true);
		// Recording started after TTS ended but stopped within 1 s of it
		expect(recordingOverlappedTts(1600, 2400, t)).toBe(true);
		// Clear gap of more than 1 s
		expect(recordingOverlappedTts(2600, 3000, t)).toBe(false);
	});

	test("trackTts marks start and end around a process", async () => {
		const t = createTtsTracker();
		let resolve!: () => void;
		const exited = new Promise<void>((r) => {
			resolve = r;
		});
		trackTts({ exited }, t);
		expect(t.active).toBe(1);
		resolve();
		await exited;
		await Promise.resolve();
		expect(t.active).toBe(0);
		expect(t.lastEndedAt).toBeGreaterThan(0);
	});
});

describe("no speech feedback", () => {
	test("empty clip ends in error with the No speech heard message", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "recorded" },
			{ type: "transcript", text: "" },
		]);
		expect(s.phase).toBe("error");
		expect(s.message).toBe(PTT_NO_SPEECH_MESSAGE);
	});

	test("too-short clip (engine goes recording -> idle, no transcribing) still reports it", () => {
		const s = run([
			{ type: "key", enabled: true },
			{ type: "transcript", text: "" },
		]);
		expect(s.phase).toBe("error");
		expect(s.message).toBe(PTT_NO_SPEECH_MESSAGE);
	});
});
