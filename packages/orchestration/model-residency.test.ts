/**
 * Tests for the model residency broker (#3430). Fakes only: injected unload
 * functions and a fake Ollama on 127.0.0.1. No model is loaded or downloaded.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ResidencyBroker,
	type Resident,
	type ResidentKind,
	ollamaResident,
	residencyEnabled,
} from "./model-residency";

const ORIGINAL_HOME = process.env.HOME;
beforeEach(() => {
	process.env.HOME = mkdtempSync(join(tmpdir(), "residency-home-"));
});
afterEach(() => {
	if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
	process.env.HOME = ORIGINAL_HOME;
});

function fake(kind: ResidentKind, log: string[], unload?: () => Promise<void>): Resident {
	return {
		kind,
		unload: async () => {
			log.push(`call-unload:${kind}`);
			if (unload) await unload();
		},
	};
}

describe("residencyEnabled", () => {
	test("is off unless EIGHT_RESIDENCY is exactly 1", () => {
		expect(residencyEnabled({})).toBe(false);
		expect(residencyEnabled({ EIGHT_RESIDENCY: "0" })).toBe(false);
		expect(residencyEnabled({ EIGHT_RESIDENCY: "true" })).toBe(false);
		expect(residencyEnabled({ EIGHT_RESIDENCY: "1" })).toBe(true);
	});
});

describe("ResidencyBroker", () => {
	test("one voice turn: listen, think, speak take turns in memory", async () => {
		const log: string[] = [];
		const broker = new ResidencyBroker([fake("stt", log), fake("llm", log), fake("tts", log)], {
			onEvent: (e) => log.push(e),
		});
		await broker.enter("listen");
		await broker.enter("think");
		await broker.enter("speak");
		expect(log).toEqual([
			// listen: the thinker and speaker leave, the listener owns memory
			"unload:llm",
			"call-unload:llm",
			"unload:tts",
			"call-unload:tts",
			"load:stt",
			// think: the listener leaves
			"unload:stt",
			"call-unload:stt",
			"load:llm",
			// speak: the thinker leaves
			"unload:llm",
			"call-unload:llm",
			"load:tts",
		]);
		expect(broker.isResident("tts")).toBe(true);
		expect(broker.isResident("llm")).toBe(false);
	});

	test("a model already unloaded is not unloaded again", async () => {
		const log: string[] = [];
		const broker = new ResidencyBroker([fake("llm", log)]);
		await broker.enter("listen");
		await broker.enter("speak");
		expect(log).toEqual(["call-unload:llm"]);
	});

	test("a busy model is never evicted", async () => {
		const log: string[] = [];
		const broker = new ResidencyBroker([fake("llm", log)]);
		broker.setBusy("llm", true);
		await broker.enter("speak");
		expect(log).toEqual([]);
		expect(broker.isResident("llm")).toBe(true);
		broker.setBusy("llm", false);
		await broker.enter("speak");
		expect(log).toEqual(["call-unload:llm"]);
	});

	test("an unload that throws never blocks the turn", async () => {
		const log: string[] = [];
		const broker = new ResidencyBroker(
			[
				fake("llm", log, async () => {
					throw new Error("ollama down");
				}),
			],
			{ onEvent: (e) => log.push(e) },
		);
		await broker.enter("listen");
		expect(log).toEqual(["unload:llm", "call-unload:llm", "unload-failed:llm", "load:stt"]);
	});

	test("an unload that hangs is abandoned after the timeout", async () => {
		const log: string[] = [];
		const broker = new ResidencyBroker([fake("llm", log, () => new Promise<void>(() => {}))], {
			unloadTimeoutMs: 30,
			onEvent: (e) => log.push(e),
		});
		const t0 = Date.now();
		await broker.enter("listen");
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(log).toContain("unload-failed:llm");
		expect(log.at(-1)).toBe("load:stt");
	});
});

describe("ollamaResident against a fake Ollama", () => {
	test("unloads every model Ollama reports as loaded, with keep_alive 0", async () => {
		const calls: Array<{ path: string; body?: unknown }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/api/ps") {
					calls.push({ path });
					return Response.json({
						models: [{ name: "qwen3:14b", model: "qwen3:14b" }, { name: "gemma:2b" }],
					});
				}
				calls.push({ path, body: await req.json() });
				return Response.json({ done: true });
			},
		});
		try {
			await ollamaResident(`http://127.0.0.1:${server.port}`).unload();
			expect(calls).toEqual([
				{ path: "/api/ps" },
				{ path: "/api/generate", body: { model: "qwen3:14b", keep_alive: 0 } },
				{ path: "/api/generate", body: { model: "gemma:2b", keep_alive: 0 } },
			]);
		} finally {
			server.stop(true);
		}
	});

	test("an unreachable Ollama fails the unload without blocking the broker", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
		const url = `http://127.0.0.1:${server.port}`;
		server.stop(true);
		const events: string[] = [];
		const broker = new ResidencyBroker([ollamaResident(url, 200)], {
			onEvent: (e) => events.push(e),
		});
		await broker.enter("listen");
		expect(events).toEqual(["unload:llm", "unload-failed:llm", "load:stt"]);
	});
});
