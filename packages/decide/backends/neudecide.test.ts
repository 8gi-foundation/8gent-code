/**
 * NeuDecide audio backend tests. Fully offline: no weights, no Python.
 * The real backend's subprocess is replaced by an injected runner.
 */

import { describe, expect, it } from "bun:test";
import {
	type AudioCandidate,
	MAX_AUDIO_MS,
	MockAudioBackend,
	NeuDecideBackend,
	pickIntent,
	pythonRunner,
	routeVoiceAudio,
	voiceDecideEnabled,
	wavDurationMs,
} from "./neudecide";

/** A minimal 16 kHz mono 16-bit PCM WAV of `ms` milliseconds of silence. */
function wav(ms: number): Uint8Array {
	const dataBytes = Math.round((16000 * ms) / 1000) * 2;
	const buf = new Uint8Array(44 + dataBytes);
	const v = new DataView(buf.buffer);
	const ascii = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	v.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, 16000, true);
	v.setUint32(28, 32000, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	ascii(36, "data");
	v.setUint32(40, dataBytes, true);
	return buf;
}

const CANDIDATES: AudioCandidate[] = [
	{ name: "help", description: "Read the available voice commands." },
	{ name: "scratch", description: "Clear the current input." },
	{ name: "newline", description: "Insert a line break." },
];

describe("voiceDecideEnabled", () => {
	it("is off by default and on only for exactly 1", () => {
		expect(voiceDecideEnabled({})).toBe(false);
		expect(voiceDecideEnabled({ EIGHT_VOICE_DECIDE: "0" })).toBe(false);
		expect(voiceDecideEnabled({ EIGHT_VOICE_DECIDE: "true" })).toBe(false);
		expect(voiceDecideEnabled({ EIGHT_VOICE_DECIDE: "1" })).toBe(true);
	});
});

describe("wavDurationMs", () => {
	it("reads duration from the data chunk", () => {
		expect(wavDurationMs(wav(1500))).toBe(1500);
	});
	it("returns null for something that is not a WAV", () => {
		expect(wavDurationMs(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});

describe("MockAudioBackend", () => {
	it("returns a choice answer with the same shape as text backends", async () => {
		const backend = new MockAudioBackend(() => [0.1, 0.85, 0.05]);
		const res = await backend.ask({ audio: wav(800), candidates: CANDIDATES });
		expect(res.backend).toBe("mock-audio");
		expect(res.answer?.kind).toBe("choice");
		expect(res.answer?.chosen).toBe(1);
		expect(res.answer?.confidence).toBeCloseTo(0.85);
		expect(res.answer?.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
	});
	it("returns no answer when the scorer says no tool applies", async () => {
		const backend = new MockAudioBackend(() => null);
		const res = await backend.ask({ audio: wav(800), candidates: CANDIDATES });
		expect(res.answer).toBeNull();
	});
	it("rejects fewer than 2 candidates", async () => {
		const backend = new MockAudioBackend(() => [1]);
		await expect(backend.ask({ audio: wav(800), candidates: [CANDIDATES[0]] })).rejects.toThrow();
	});
});

describe("pickIntent (code owns the threshold)", () => {
	it("returns the choice when confidence clears the threshold", async () => {
		const res = await new MockAudioBackend(() => [0.9, 0.05, 0.05]).ask({
			audio: wav(800),
			candidates: CANDIDATES,
		});
		expect(pickIntent(res, CANDIDATES, 0.8)).toEqual({ choice: "help", confidence: 0.9 });
	});
	it("is unsure below the threshold", async () => {
		const res = await new MockAudioBackend(() => [0.5, 0.3, 0.2]).ask({
			audio: wav(800),
			candidates: CANDIDATES,
		});
		expect(pickIntent(res, CANDIDATES, 0.8)).toBe("unsure");
	});
	it("is unsure when no tool applies", async () => {
		const res = await new MockAudioBackend(() => null).ask({
			audio: wav(800),
			candidates: CANDIDATES,
		});
		expect(pickIntent(res, CANDIDATES, 0.8)).toBe("unsure");
	});
});

describe("NeuDecideBackend (injected runner, no Python)", () => {
	it("maps a single known call to that candidate and reports itself uncalibrated", async () => {
		let seenTools = "";
		const backend = new NeuDecideBackend({
			run: async (_wavPath, toolsJson) => {
				seenTools = toolsJson;
				return '[{"name": "scratch", "arguments": {}}]';
			},
		});
		const res = await backend.ask({ audio: wav(800), candidates: CANDIDATES });
		expect(res.calibrated).toBe(false);
		expect(res.answer?.chosen).toBe(1);
		const tools = JSON.parse(seenTools);
		expect(tools.map((t: { name: string }) => t.name)).toEqual(["help", "scratch", "newline"]);
		expect(tools[0].parameters).toEqual({ type: "object", properties: {} });
	});
	it("treats an empty list, several calls, or an unknown name as no answer", async () => {
		for (const out of ["[]", '[{"name":"help"},{"name":"scratch"}]', '[{"name":"rm_rf"}]']) {
			const backend = new NeuDecideBackend({ run: async () => out });
			const res = await backend.ask({ audio: wav(800), candidates: CANDIDATES });
			expect(res.answer).toBeNull();
		}
	});
	it("throws on output that is not JSON", async () => {
		const backend = new NeuDecideBackend({ run: async () => "Traceback: 401 gated repo" });
		await expect(backend.ask({ audio: wav(800), candidates: CANDIDATES })).rejects.toThrow();
	});
});

describe("routeVoiceAudio", () => {
	it("routes when the backend is confident", async () => {
		const backend = new MockAudioBackend(() => [0.95, 0.03, 0.02]);
		const r = await routeVoiceAudio(backend, wav(800), CANDIDATES);
		expect(r).toEqual({ routed: true, choice: "help", confidence: 0.95, backend: "mock-audio" });
	});
	it("falls back when unsure", async () => {
		const backend = new MockAudioBackend(() => [0.4, 0.3, 0.3]);
		const r = await routeVoiceAudio(backend, wav(800), CANDIDATES);
		expect(r.routed).toBe(false);
		if (!r.routed) expect(r.reason).toBe("unsure");
	});
	it("falls back without calling the backend for audio over the 30 s cap", async () => {
		let called = false;
		const backend = new MockAudioBackend(() => {
			called = true;
			return [1, 0, 0];
		});
		const r = await routeVoiceAudio(backend, wav(MAX_AUDIO_MS + 1000), CANDIDATES);
		expect(called).toBe(false);
		expect(r.routed).toBe(false);
		if (!r.routed) expect(r.reason).toBe("too-long");
	});
	it("falls back when the backend throws (weights missing, gate, crash)", async () => {
		const backend = new NeuDecideBackend({
			run: async () => {
				throw new Error("python3 not found");
			},
		});
		const r = await routeVoiceAudio(backend, wav(800), CANDIDATES);
		expect(r.routed).toBe(false);
		if (!r.routed) expect(r.reason).toBe("error");
	});
	it("falls back on timeout", async () => {
		const backend = new NeuDecideBackend({
			run: () => new Promise((res) => setTimeout(() => res("[]"), 200)),
		});
		const r = await routeVoiceAudio(backend, wav(800), CANDIDATES, { timeoutMs: 20 });
		expect(r.routed).toBe(false);
		if (!r.routed) expect(r.reason).toBe("error");
	});
});

describe("pythonRunner (mocked spawn)", () => {
	function fakeSpawn(hang = false) {
		const calls: { cmd: string[]; opts: Record<string, unknown> }[] = [];
		let killed = 0;
		let release: (n: number) => void = () => {};
		const spawn = (cmd: string[], opts: Record<string, unknown>) => {
			calls.push({ cmd, opts });
			const text = (t: string) => new Response(t).body;
			const exited = hang
				? new Promise<number>((r) => {
						release = r;
					})
				: Promise.resolve(0);
			return {
				stdout: text("[]"),
				stderr: text(""),
				exited,
				kill: () => {
					killed++;
					release(137);
				},
			};
		};
		return { spawn, calls, killed: () => killed };
	}

	it("runs python isolated (-I) from the wav's temp dir, not the project dir", async () => {
		const f = fakeSpawn();
		const run = pythonRunner({ EIGHT_NEUDECIDE_PYTHON: "py" }, f.spawn);
		await run("/tmp/8gent-neudecide-x/in.wav", "[]");
		expect(f.calls[0].cmd.slice(0, 3)).toEqual(["py", "-I", "-c"]);
		expect(f.calls[0].opts.cwd).toBe("/tmp/8gent-neudecide-x");
		expect(f.calls[0].opts.cwd).not.toBe(process.cwd());
	});
	it("kills the child when the router times out", async () => {
		const f = fakeSpawn(true);
		const backend = new NeuDecideBackend({ run: pythonRunner({}, f.spawn) });
		const r = await routeVoiceAudio(backend, wav(800), CANDIDATES, { timeoutMs: 20 });
		expect(r.routed).toBe(false);
		if (!r.routed) expect(r.detail).toBe("timeout");
		await new Promise((res) => setTimeout(res, 10));
		expect(f.killed()).toBe(1);
	});
});
