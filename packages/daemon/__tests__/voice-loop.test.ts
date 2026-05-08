/**
 * Tests for the voice-out / voice-in wiring (cross-surface dispatch
 * sprint, wave 2).
 *
 * Voice-out:
 *   - speakReplyLocally invokes the speak helper exactly once when
 *     EIGHT_VOICE_OUT_LOCAL=1, with text truncated at 800 chars.
 *   - Returns null without invoking the helper when env is unset.
 *   - installVoiceOutForBus speaks final agent:stream events for
 *     telegram-channel sessions only; ignores other channels and
 *     non-final chunks.
 *
 * Voice-in:
 *   - The transcribeVoiceMessage helper is reachable from the bridge
 *     module and uses the injected fetch implementation. Verifies the
 *     local bridge inherits the same transcription pipeline (no env
 *     gate other than GROQ/OPENAI keys).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { EventBus } from "../events";
import { transcribeVoiceMessage } from "../telegram-bridge";
import { type VoiceOutDeps, installVoiceOutForBus, speakReplyLocally } from "../voice-out";

function makeRecordingDeps(): {
	deps: VoiceOutDeps;
	calls: { text: string; voice: string }[];
} {
	const calls: { text: string; voice: string }[] = [];
	const deps: VoiceOutDeps = {
		hasKittenTTS: async () => true,
		speak: async (text, voice) => {
			calls.push({ text, voice });
			return { kill: () => {} };
		},
	};
	return { deps, calls };
}

describe("voice-out - speakReplyLocally", () => {
	const snapshotEnv = process.env.EIGHT_VOICE_OUT_LOCAL;
	const snapshotVoice = process.env.EIGHT_VOICE_OUT_VOICE;

	afterEach(() => {
		if (snapshotEnv === undefined) delete process.env.EIGHT_VOICE_OUT_LOCAL;
		else process.env.EIGHT_VOICE_OUT_LOCAL = snapshotEnv;
		if (snapshotVoice === undefined) delete process.env.EIGHT_VOICE_OUT_VOICE;
		else process.env.EIGHT_VOICE_OUT_VOICE = snapshotVoice;
	});

	it("returns null and does not invoke the helper when env is unset", async () => {
		delete process.env.EIGHT_VOICE_OUT_LOCAL;
		const { deps, calls } = makeRecordingDeps();
		const result = await speakReplyLocally("hello world", deps);
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("invokes the helper once when env is set", async () => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
		const { deps, calls } = makeRecordingDeps();
		const result = await speakReplyLocally("hello world", deps);
		expect(result).not.toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toBe("hello world");
	});

	it("truncates text to 800 characters", async () => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
		const { deps, calls } = makeRecordingDeps();
		const long = "a".repeat(2_000);
		await speakReplyLocally(long, deps);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.text.length).toBe(800);
	});

	it("uses default voice expr-voice-2-m when EIGHT_VOICE_OUT_VOICE is unset", async () => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
		delete process.env.EIGHT_VOICE_OUT_VOICE;
		const { deps, calls } = makeRecordingDeps();
		await speakReplyLocally("hi", deps);
		expect(calls[0]?.voice).toBe("expr-voice-2-m");
	});

	it("honors EIGHT_VOICE_OUT_VOICE override", async () => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
		process.env.EIGHT_VOICE_OUT_VOICE = "expr-voice-3-f";
		const { deps, calls } = makeRecordingDeps();
		await speakReplyLocally("hi", deps);
		expect(calls[0]?.voice).toBe("expr-voice-3-f");
	});

	it("does not throw when the speak helper rejects", async () => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
		const deps: VoiceOutDeps = {
			hasKittenTTS: async () => false,
			speak: async () => {
				throw new Error("synth crashed");
			},
		};
		const result = await speakReplyLocally("hi", deps);
		expect(result).toBeNull();
	});
});

describe("voice-out - installVoiceOutForBus", () => {
	const snapshotEnv = process.env.EIGHT_VOICE_OUT_LOCAL;

	beforeEach(() => {
		process.env.EIGHT_VOICE_OUT_LOCAL = "1";
	});

	afterEach(() => {
		if (snapshotEnv === undefined) delete process.env.EIGHT_VOICE_OUT_LOCAL;
		else process.env.EIGHT_VOICE_OUT_LOCAL = snapshotEnv;
	});

	it("speaks a final stream from a telegram session", async () => {
		const bus = new EventBus();
		const { deps, calls } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		try {
			bus.emit("session:start", { sessionId: "s1", channel: "telegram" });
			bus.emit("agent:stream", { sessionId: "s1", chunk: "spoken reply", final: true });
			// Helper is fire-and-forget; allow the microtask to land.
			await new Promise((r) => setTimeout(r, 5));
			expect(calls).toHaveLength(1);
			expect(calls[0]?.text).toBe("spoken reply");
		} finally {
			handle.uninstall();
		}
	});

	it("ignores non-telegram channels", async () => {
		const bus = new EventBus();
		const { deps, calls } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		try {
			bus.emit("session:start", { sessionId: "s2", channel: "os" });
			bus.emit("agent:stream", { sessionId: "s2", chunk: "tui reply", final: true });
			await new Promise((r) => setTimeout(r, 5));
			expect(calls).toHaveLength(0);
		} finally {
			handle.uninstall();
		}
	});

	it("ignores non-final chunks", async () => {
		const bus = new EventBus();
		const { deps, calls } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		try {
			bus.emit("session:start", { sessionId: "s3", channel: "telegram" });
			bus.emit("agent:stream", { sessionId: "s3", chunk: "partial", final: false });
			bus.emit("agent:stream", { sessionId: "s3", chunk: "more partial" });
			await new Promise((r) => setTimeout(r, 5));
			expect(calls).toHaveLength(0);
		} finally {
			handle.uninstall();
		}
	});

	it("does not invoke the helper when EIGHT_VOICE_OUT_LOCAL is unset", async () => {
		delete process.env.EIGHT_VOICE_OUT_LOCAL;
		const bus = new EventBus();
		const { deps, calls } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		try {
			bus.emit("session:start", { sessionId: "s4", channel: "telegram" });
			bus.emit("agent:stream", { sessionId: "s4", chunk: "should not speak", final: true });
			await new Promise((r) => setTimeout(r, 5));
			expect(calls).toHaveLength(0);
		} finally {
			handle.uninstall();
		}
	});

	it("releases listeners on uninstall", async () => {
		const bus = new EventBus();
		const { deps } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		const before = bus.size;
		handle.uninstall();
		const after = bus.size;
		expect(before - after).toBe(3); // session:start, session:end, agent:stream
	});

	it("forgets a session when session:end fires", async () => {
		const bus = new EventBus();
		const { deps } = makeRecordingDeps();
		const handle = installVoiceOutForBus({ bus, deps });
		try {
			bus.emit("session:start", { sessionId: "s5", channel: "telegram" });
			expect(handle.tracked()).toBe(1);
			bus.emit("session:end", { sessionId: "s5", reason: "turn-complete" });
			expect(handle.tracked()).toBe(0);
		} finally {
			handle.uninstall();
		}
	});
});

describe("voice-in - transcribeVoiceMessage", () => {
	const snapshot = {
		groq: process.env.GROQ_API_KEY,
		openai: process.env.OPENAI_API_KEY,
	};

	beforeEach(() => {
		delete process.env.GROQ_API_KEY;
		delete process.env.OPENAI_API_KEY;
	});

	afterEach(() => {
		if (snapshot.groq === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = snapshot.groq;
		if (snapshot.openai === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = snapshot.openai;
	});

	it("returns a bracketed error when no transcription key is set", async () => {
		const fakeFetch = mock(async (url: string) => {
			if (url.includes("/getFile")) {
				return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/abc.ogg" } }));
			}
			if (url.includes("api.telegram.org/file/")) {
				return new Response(new Uint8Array([0, 1, 2, 3]).buffer);
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const result = await transcribeVoiceMessage(
			"token",
			"file_1",
			fakeFetch as unknown as typeof fetch,
		);
		expect(result.startsWith("[")).toBe(true);
		expect(result).toContain("GROQ_API_KEY");
	});

	it("calls the Groq endpoint when GROQ_API_KEY is set", async () => {
		process.env.GROQ_API_KEY = "test-groq-key";
		const visited: string[] = [];
		const fakeFetch = mock(async (url: string) => {
			visited.push(url);
			if (url.includes("/getFile")) {
				return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/abc.ogg" } }));
			}
			if (url.includes("api.telegram.org/file/")) {
				return new Response(new Uint8Array([0, 1, 2, 3]).buffer);
			}
			if (url.includes("groq.com")) {
				return new Response(JSON.stringify({ text: "8 read me the cardone decision" }), {
					status: 200,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const result = await transcribeVoiceMessage(
			"token",
			"file_2",
			fakeFetch as unknown as typeof fetch,
		);
		expect(result).toBe("8 read me the cardone decision");
		expect(visited.some((u) => u.includes("groq.com"))).toBe(true);
		expect(visited.some((u) => u.includes("openai.com/v1/audio"))).toBe(false);
	});

	it("falls back to OpenAI when only OPENAI_API_KEY is set", async () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const visited: string[] = [];
		const fakeFetch = mock(async (url: string) => {
			visited.push(url);
			if (url.includes("/getFile")) {
				return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/abc.ogg" } }));
			}
			if (url.includes("api.telegram.org/file/")) {
				return new Response(new Uint8Array([0, 1, 2, 3]).buffer);
			}
			if (url.includes("api.openai.com")) {
				return new Response(JSON.stringify({ text: "fallback path" }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const result = await transcribeVoiceMessage(
			"token",
			"file_3",
			fakeFetch as unknown as typeof fetch,
		);
		expect(result).toBe("fallback path");
		expect(visited.some((u) => u.includes("api.openai.com"))).toBe(true);
	});
});
