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

/** Build a loop whose listen and speak steps only log, then run one turn. */
async function runTurn(
	log: string[],
	extra: { residency?: { enter: (p: "listen" | "think" | "speak") => Promise<void> } },
) {
	const messageArgs: unknown[][] = [];
	const loop = new VoiceChatLoop({
		engine: {} as VoiceEngine,
		onMessage: async (...args: unknown[]) => {
			messageArgs.push(args);
			log.push("agent");
			return "hello back";
		},
		...extra,
	});
	const internals = loop as unknown as Record<string, unknown>;
	internals.listenForSpeech = async () => {
		log.push("record+transcribe");
		return "hello";
	};
	internals.speakText = async () => {
		log.push("tts");
	};
	internals.running = true;
	await (internals.runOneTurn as () => Promise<void>).call(loop);
	return messageArgs;
}

describe("VoiceChatLoop residency", () => {
	test("flag off: the turn is unchanged and the residency hook is never called", async () => {
		delete process.env.EIGHT_RESIDENCY;
		const log: string[] = [];
		const args = await runTurn(log, {
			residency: { enter: async (p) => void log.push(`enter:${p}`) },
		});
		expect(log).toEqual(["record+transcribe", "agent", "tts"]);
		expect(args).toEqual([["hello"]]);
	});

	test("flag on: each phase is entered before it runs, and the agent gets thinking off", async () => {
		process.env.EIGHT_RESIDENCY = "1";
		const log: string[] = [];
		const args = await runTurn(log, {
			residency: { enter: async (p) => void log.push(`enter:${p}`) },
		});
		expect(log).toEqual([
			"enter:listen",
			"record+transcribe",
			"enter:think",
			"agent",
			"enter:speak",
			"tts",
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
		expect(log).toEqual(["record+transcribe", "agent", "tts"]);
	});

	test("flag on, default broker: unloads the fake Ollama model before listen and before speak", async () => {
		const hits: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/api/ps") {
					hits.push("ps");
					return Response.json({ models: [{ model: "fake:1b" }] });
				}
				const body = (await req.json()) as { model: string; keep_alive: number };
				hits.push(`unload ${body.model} keep_alive=${body.keep_alive}`);
				return Response.json({ done: true });
			},
		});
		try {
			process.env.EIGHT_RESIDENCY = "1";
			process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}`;
			const log: string[] = [];
			const loop = new VoiceChatLoop({
				engine: {} as VoiceEngine,
				onMessage: async () => {
					log.push(`agent (unloads so far: ${hits.length})`);
					return "ok";
				},
			});
			const internals = loop as unknown as Record<string, unknown>;
			internals.listenForSpeech = async () => {
				log.push(`listen (unloads so far: ${hits.length})`);
				return "hi";
			};
			internals.speakText = async () => {
				log.push(`speak (unloads so far: ${hits.length})`);
			};
			internals.running = true;
			await (internals.runOneTurn as () => Promise<void>).call(loop);
			expect(hits).toEqual([
				"ps",
				"unload fake:1b keep_alive=0",
				"ps",
				"unload fake:1b keep_alive=0",
			]);
			expect(log).toEqual([
				"listen (unloads so far: 2)",
				"agent (unloads so far: 2)",
				"speak (unloads so far: 4)",
			]);
		} finally {
			server.stop(true);
		}
	});
});
