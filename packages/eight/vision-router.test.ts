import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { VisionInterpreter } from "./vision-interpreter";
import { findVisionModel, isKnownVisionModel, loadVisionConfig } from "./vision-router";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function ollamaHas(...names: string[]) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
			status: 200,
		})) as unknown as typeof fetch;
}

describe("vision router model-name matching (#3715)", () => {
	test("Ollama's real tag qwen2.5vl:7b is found as the default vision model", async () => {
		ollamaHas("qwen3.8:27b-mlx", "qwen2.5vl:7b");
		const r = await findVisionModel({ config: { ...loadVisionConfig(), defaultModel: "qwen2.5-vl:latest" } });
		expect(r.found).toBe(true);
		expect(r.model?.model).toBe("qwen2.5vl:7b");
	});

	test("auto-discovery finds qwen2.5vl when the preferred model is absent", async () => {
		ollamaHas("qwen2.5vl:7b");
		const r = await findVisionModel({ config: { ...loadVisionConfig(), defaultModel: "nothing:latest" } });
		expect(r.model?.model).toBe("qwen2.5vl:7b");
	});

	test("a text-only model is not mistaken for a vision model", async () => {
		ollamaHas("qwen3.8:27b-mlx");
		const r = await findVisionModel({
			config: { ...loadVisionConfig(), preferLocal: true, defaultModel: "qwen2.5-vl:latest" },
			openRouterApiKey: undefined,
		});
		expect(r.model?.model).not.toBe("qwen3.8:27b-mlx");
	});

	test("isKnownVisionModel accepts both spellings", () => {
		expect(isKnownVisionModel("qwen2.5vl:7b")).toBe(true);
		expect(isKnownVisionModel("qwen2.5-vl:7b")).toBe(true);
		expect(isKnownVisionModel("qwen3.8:27b-mlx")).toBe(false);
	});
});

describe("vision interpreter failure is reported (#3715)", () => {
	test("onError fires with the reason when no vision model is available", async () => {
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const errors: string[] = [];
		const vi = new VisionInterpreter({ onError: (_id, msg) => errors.push(msg) });
		const id = vi.interpret("aGVsbG8=", "image/png");
		await vi.waitFor(id);
		await new Promise((r) => setTimeout(r, 0));
		expect(errors.length).toBe(1);
		expect(errors[0].length).toBeGreaterThan(0);
	});
});
