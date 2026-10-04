/**
 * VoiceChatLoop with and without EIGHT_RESIDENCY (#3430). The microphone,
 * whisper and TTS steps are replaced on the instance, so nothing records,
 * transcribes, speaks or loads a model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceEngine } from "./index.js";
import { VoiceChatLoop } from "./voice-chat.js";

const ORIGINAL = {
	HOME: process.env.HOME,
	FLAG: process.env.EIGHT_RESIDENCY,
	OLLAMA: process.env.OLLAMA_BASE_URL,
};
beforeEach(() => {
	process.env.HOME = mkdtempSync(join(tmpdir(), "voice-residency-home-"));
});
afterEach(() => {
	if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
	process.env.HOME = ORIGINAL.HOME;
	for (const [k, v] of [
		["EIGHT_RESIDENCY", ORIGINAL.FLAG],
		["OLLAMA_BASE_URL", ORIGINAL.OLLAMA],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

type Hook = { enter: (p: "listen" | "think" | "speak") => Promise<void> };

/** Build a loop whose mic, whisper and TTS steps only log, run one turn, then let queued residency steps finish. */
async function runTurn(log: string[], extra: { residency?: Hook } = {}) {
	const messageArgs: unknown[][] = [];
	const loop = new VoiceChatLoop({
		engine: {} as VoiceEngine,
		onMessage: async (...args: unknown[]) => {
			messageArgs.push(args);
			log.push("agent");
			return "hello back";
		},
		onStateChange: (state) => log.push(`state:${state}`),
		...extra,
	});
	const internals = loop as unknown as Record<string, unknown>;
	internals.listenForSpeech = async () => {
		log.push("record");
		return "hello";
	};
	internals.speakText = async () => {
		log.push("tts");
	};
	internals.running = true;
	await (internals.runOneTurn as () => Promise<void>).call(loop);
	await internals.residencyChain;
	return messageArgs;
}

const slow =
	(log: string[], ms: number): Hook["enter"] =>
	async (p) => {
		await Bun.sleep(ms);
		log.push(`enter:${p} done`);
	};

describe("VoiceChatLoop residency", () => {
	test("flag off: the turn is unchanged and the residency hook is never called", async () => {
		delete process.env.EIGHT_RESIDENCY;
		const log: string[] = [];
		const args = await runTurn(log, { residency: { enter: slow(log, 0) } });
		expect(log).toEqual([
			"state:listening",
			"record",
			"state:thinking",
			"agent",
			"state:speaking",
			"tts",
		]);
		expect(args).toEqual([["hello"]]);
	});

	test("flag on: recording and TTS start with their state change, not after the unload", async () => {
		process.env.EIGHT_RESIDENCY = "1";
		const log: string[] = [];
		const args = await runTurn(log, { residency: { enter: slow(log, 50) } });
		expect(log).toEqual([
			"state:listening",
			"record", // the mic opens at once; the listen step runs behind it
			"state:thinking",
			"enter:listen done",
			"enter:think done", // the agent waits for think (bounded)
			"agent",
			"state:speaking",
			"tts", // TTS starts at once; the speak step runs behind it
			"enter:speak done",
		]);
		expect(args).toEqual([["hello", { live: true, thinking: null }]]);
	});

	test("flag on: a residency hook that throws never blocks the turn", async () => {
		process.env.EIGHT_RESIDENCY = "1";
		const log: string[] = [];
		await runTurn(log, {
			residency: {
				enter: async () => {
					throw new Error("broker down");
				},
			},
		});
		expect(log).toEqual([
			"state:listening",
			"record",
			"state:thinking",
			"agent",
			"state:speaking",
			"tts",
		]);
	});

	test("flag on: a hook that hangs delays the agent by at most 2.5 s", async () => {
		process.env.EIGHT_RESIDENCY = "1";
		const log: string[] = [];
		const loop = new VoiceChatLoop({
			engine: {} as VoiceEngine,
			onMessage: async () => {
				log.push("agent");
				return "ok";
			},
			residency: { enter: () => new Promise<void>(() => {}) },
		});
		const internals = loop as unknown as Record<string, unknown>;
		internals.listenForSpeech = async () => "hi";
		internals.speakText = async () => void log.push("tts");
		internals.running = true;
		const t0 = Date.now();
		await (internals.runOneTurn as () => Promise<void>).call(loop);
		expect(Date.now() - t0).toBeLessThan(3500);
		expect(log).toEqual(["agent", "tts"]);
	});

	test("flag on, default broker: unloads only the models the think step used", async () => {
		let psCalls = 0;
		const unloads: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				if (new URL(req.url).pathname === "/api/ps") {
					psCalls++;
					// call 1 = snapshot before think; call 2 = before speak, after the agent used its model
					return Response.json({
						models: [
							{ model: "agent:14b", expires_at: psCalls === 1 ? "t1" : "t2" },
							{ model: "other-session:7b", expires_at: "t0" },
						],
					});
				}
				const body = (await req.json()) as { model: string; keep_alive: number };
				unloads.push(`${body.model} keep_alive=${body.keep_alive}`);
				return Response.json({ done: true });
			},
		});
		try {
			process.env.EIGHT_RESIDENCY = "1";
			process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}`;
			const log: string[] = [];
			await runTurn(log);
			expect(psCalls).toBe(2);
			expect(unloads).toEqual(["agent:14b keep_alive=0"]);
			expect(log).toEqual([
				"state:listening",
				"record",
				"state:thinking",
				"agent",
				"state:speaking",
				"tts",
			]);
		} finally {
			server.stop(true);
		}
	});
});
