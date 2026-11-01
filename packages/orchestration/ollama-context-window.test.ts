/**
 * #3643: an Ollama run's compaction window is the model's real context, not
 * the hardcoded 32768 fallback. Read from the server (/api/ps for a loaded
 * model, else the Modelfile num_ctx or the model's context_length from
 * /api/show). Unreadable: null, so the caller keeps the fallback. The fetch
 * is injected; nothing touches the network.
 */

import { describe, expect, test } from "bun:test";
import { ProactiveCompression } from "../eight/compaction";
import { ollamaContextWindowLookup } from "./local-model-detect";

type Routes = { ps?: unknown; show?: unknown; fail?: boolean };

function fakeFetch(routes: Routes, seen: string[] = []): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		seen.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
		if (routes.fail) throw new Error("connect ECONNREFUSED");
		if (url.endsWith("/api/ps")) return Response.json(routes.ps ?? { models: [] });
		if (url.endsWith("/api/show")) {
			return routes.show ? Response.json(routes.show) : new Response("not found", { status: 404 });
		}
		return new Response("?", { status: 404 });
	}) as unknown as typeof fetch;
}

const MODEL = "qwen-fake:27b";

describe("ollamaContextWindowLookup", () => {
	test("a loaded model: the runner's context_length from /api/ps wins (that is what truncates)", async () => {
		const got = await ollamaContextWindowLookup(
			{ baseUrl: "http://localhost:11434/v1", model: MODEL },
			fakeFetch({
				ps: { models: [{ name: MODEL, model: MODEL, context_length: 262144 }] },
				show: { model_info: { "qwen3.context_length": 40960 } },
			}),
		);
		expect(got).toBe(262144);
	});

	test("not loaded: a Modelfile num_ctx beats the architecture maximum", async () => {
		const got = await ollamaContextWindowLookup(
			{ baseUrl: "http://localhost:11434", model: MODEL },
			fakeFetch({
				show: {
					parameters: 'stop "<|im_end|>"\nnum_ctx                        65536',
					model_info: { "qwen3.context_length": 262144 },
				},
			}),
		);
		expect(got).toBe(65536);
	});

	test("not loaded, no num_ctx: the model's <arch>.context_length from /api/show", async () => {
		const seen: string[] = [];
		const got = await ollamaContextWindowLookup(
			{ baseUrl: "http://localhost:11434/v1/chat/completions", model: MODEL },
			fakeFetch({ show: { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 } } }, seen),
		);
		expect(got).toBe(262144);
		// The /v1 suffix is stripped: native API paths on the server root.
		expect(seen.some((s) => s.startsWith("POST http://localhost:11434/api/show") && s.includes(MODEL))).toBe(true);
	});

	test("unreachable or unknown: null, never an invented number", async () => {
		expect(await ollamaContextWindowLookup({ baseUrl: "http://localhost:11434", model: MODEL }, fakeFetch({ fail: true }))).toBeNull();
		expect(await ollamaContextWindowLookup({ baseUrl: "http://localhost:11434", model: MODEL }, fakeFetch({}))).toBeNull();
		expect(await ollamaContextWindowLookup({ baseUrl: "", model: MODEL }, fakeFetch({}))).toBeNull();
	});
});

describe("the window decides whether a long first message is compacted (#3643 validation 1)", () => {
	// Synthetic document of about 30k tokens (4 characters per token).
	const doc = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2_200);
	const messages = [
		{ role: "system" as const, content: "You answer questions about documents." },
		{ role: "user" as const, content: doc },
	];

	test("with the real 262144 window: no compaction", () => {
		expect(new ProactiveCompression({ contextWindow: 262144 }).getStage(messages)).toBe("none");
	});

	test("with the old 32768 fallback: compaction would fire", () => {
		expect(new ProactiveCompression({ contextWindow: 32768 }).getStage(messages)).not.toBe("none");
	});
});
