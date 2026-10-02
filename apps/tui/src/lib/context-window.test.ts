import { describe, expect, test } from "bun:test";
import { contextMeterText } from "../components/LiveFocalStrip.js";
import {
	UNKNOWN_WINDOW,
	contextMeter,
	resolveContextWindow,
	stepContextUsed,
} from "./context-window.js";

const json = (body: unknown, ok = true) =>
	(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
const down = (async () => {
	throw new Error("down");
}) as unknown as typeof fetch;

describe("contextMeter: bar against the real window", () => {
	test("8k model at 6k used is near full", () => {
		const m = contextMeter(6000, { window: 8192, source: "provider" });
		expect(m).toEqual({ kind: "measured", pct: 73, source: "provider" });
	});
	test("1M model at 200k used is about 20%", () => {
		const m = contextMeter(200_000, { window: 1_000_000, source: "provider" });
		expect(m).toEqual({ kind: "measured", pct: 20, source: "provider" });
	});
	test("unknown window never yields a percent", () => {
		const m = contextMeter(13_800, UNKNOWN_WINDOW);
		expect(m).toEqual({ kind: "unknown", used: 13_800 });
		expect("pct" in m).toBe(false);
	});
	test("nothing measured yet is fresh, not 0%", () => {
		expect(contextMeter(null, { window: 32768, source: "server" })).toEqual({ kind: "fresh" });
	});
	test("over-reported use is capped at 100", () => {
		const m = contextMeter(50_000, { window: 8192, source: "server" });
		expect(m.kind === "measured" && m.pct).toBe(100);
	});
});

describe("stepContextUsed", () => {
	test("is the last request, prompt plus completion", () => {
		expect(stepContextUsed({ promptTokens: 13_000, completionTokens: 800, totalTokens: 13_800 })).toBe(13_800);
	});
	test("an all-zero synthetic event measures nothing", () => {
		expect(stepContextUsed({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBeNull();
	});
});

describe("resolveContextWindow", () => {
	test("openrouter: provider metadata, exact id", async () => {
		const fetchImpl = json({
			data: [
				{ id: "other/model:free", context_length: 4096 },
				{ id: "x/y:free", context_length: 1_000_000 },
			],
		});
		const w = await resolveContextWindow({ provider: "openrouter", model: "x/y:free", fetchImpl });
		expect(w).toEqual({ window: 1_000_000, source: "provider" });
	});
	test("openrouter: no exact id is unknown, never the first entry", async () => {
		const fetchImpl = json({ data: [{ id: "other/model:free", context_length: 4096 }] });
		const w = await resolveContextWindow({ provider: "openrouter", model: "x/y:free", fetchImpl });
		expect(w).toEqual(UNKNOWN_WINDOW);
	});
	test("ollama: loaded num_ctx from the server", async () => {
		const fetchImpl = json({ parameters: "num_ctx                        8192\nstop x", model_info: {} });
		const w = await resolveContextWindow({
			provider: "ollama",
			model: "qwen3:14b",
			ollamaBaseUrl: "http://127.0.0.1:11434",
			fetchImpl,
		});
		expect(w).toEqual({ window: 8192, source: "server" });
	});
	test("8gent: the default provider is the local Ollama, read via /api/show", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(String(url));
			return new Response(JSON.stringify({ parameters: "num_ctx 8192", model_info: {} }));
		}) as unknown as typeof fetch;
		const w = await resolveContextWindow({
			provider: "8gent",
			model: "eight-1.0-q3:14b",
			ollamaBaseUrl: "http://localhost:11434",
			fetchImpl,
		});
		expect(w).toEqual({ window: 8192, source: "server" });
		expect(calls).toEqual(["http://localhost:11434/api/show"]);
	});
	test("ollama: falls back to the model's trained length", async () => {
		const fetchImpl = json({ model_info: { "qwen3.context_length": 40960 } });
		const w = await resolveContextWindow({
			provider: "ollama",
			model: "qwen3:14b",
			ollamaBaseUrl: "http://127.0.0.1:11434",
			fetchImpl,
		});
		expect(w).toEqual({ window: 40960, source: "server" });
	});
	test("llama-server: n_ctx from /props", async () => {
		const fetchImpl = json({ default_generation_settings: { n_ctx: 16384 } });
		const w = await resolveContextWindow({
			provider: "llama-server",
			model: "m",
			llamaServerUrl: "http://127.0.0.1:8080",
			fetchImpl,
		});
		expect(w).toEqual({ window: 16384, source: "server" });
	});
	test("server down or unlisted provider is unknown", async () => {
		expect(
			await resolveContextWindow({ provider: "ollama", model: "m", ollamaBaseUrl: "http://x", fetchImpl: down }),
		).toEqual(UNKNOWN_WINDOW);
		expect(await resolveContextWindow({ provider: "anthropic", model: "m", fetchImpl: down })).toEqual(
			UNKNOWN_WINDOW,
		);
		expect(await resolveContextWindow({ provider: "ollama", model: "", fetchImpl: down })).toEqual(
			UNKNOWN_WINDOW,
		);
	});
});

describe("contextMeterText: the HUD slot", () => {
	test("is always 10 cells and labels its source", () => {
		expect(contextMeterText(73, "provider")).toBe("███████░░░");
		expect(contextMeterText(73, "server")).toBe("███████░░~");
		expect(contextMeterText(null, "unknown")).toBe("? unknown ");
		expect(contextMeterText(null, "fresh")).toBe("--        ");
	});
});
