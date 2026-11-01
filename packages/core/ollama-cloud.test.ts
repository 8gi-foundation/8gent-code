import { afterEach, describe, expect, test } from "bun:test";
import { pickModel } from "../decide/probe";
import { OllamaClient } from "../eight/clients/ollama";
import { createOllamaServer } from "../local-model-server";
import {
	assertOllamaLocal,
	dropOllamaCloud,
	dropOllamaCloudNames,
	isOllamaCloudModel,
	ollamaCloudAllowed,
} from "./ollama-cloud";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("isOllamaCloudModel", () => {
	test("-cloud and :cloud tags, any case", () => {
		for (const n of [
			"gpt-oss:120b-cloud",
			"qwen3-coder:480b-cloud",
			"deepseek-v3.1:671b-cloud",
			"kimi-k2:cloud",
			"X:Cloud",
		])
			expect(isOllamaCloudModel(n)).toBe(true);
	});
	test("local models are not", () => {
		for (const n of [
			"eight-1.0-q3:14b",
			"llama3.2:3b",
			"cloudy:latest",
			"my-cloud-notes:7b",
			"",
			null,
			undefined,
		])
			expect(isOllamaCloudModel(n)).toBe(false);
	});
});

describe("opt-in", () => {
	test("only an explicit yes allows it", () => {
		expect(ollamaCloudAllowed({})).toBe(false);
		expect(ollamaCloudAllowed({ EIGHT_OLLAMA_CLOUD: "0" })).toBe(false);
		expect(ollamaCloudAllowed({ EIGHT_OLLAMA_CLOUD: "maybe" })).toBe(false);
		expect(ollamaCloudAllowed({ EIGHT_OLLAMA_CLOUD: "1" })).toBe(true);
		expect(ollamaCloudAllowed({ EIGHT_OLLAMA_CLOUD: "On" })).toBe(true);
	});
	test("lists keep order, drop cloud tags, and keep them when opted in", () => {
		const names = ["a:1b", "big:480b-cloud", "b:2b"];
		expect(dropOllamaCloudNames(names, {})).toEqual(["a:1b", "b:2b"]);
		expect(dropOllamaCloudNames(names, { EIGHT_OLLAMA_CLOUD: "1" })).toEqual(names);
		expect(dropOllamaCloud([{ name: "x:cloud" }, { name: "y" }], (m) => m.name, {})).toEqual([
			{ name: "y" },
		]);
	});
	test("assertOllamaLocal throws before anything is sent, and says how to change it", () => {
		expect(() => assertOllamaLocal("gpt-oss:120b-cloud", {})).toThrow(
			/nothing was sent.*EIGHT_OLLAMA_CLOUD=1/,
		);
		expect(() => assertOllamaLocal("llama3.2:3b", {})).not.toThrow();
		expect(() =>
			assertOllamaLocal("gpt-oss:120b-cloud", { EIGHT_OLLAMA_CLOUD: "1" }),
		).not.toThrow();
	});
});

describe("where it bites", () => {
	test("a cloud tag has a tiny size, so the size-ordered pick would choose it first; pickModel never does", () => {
		const installed = [
			{ name: "gpt-oss:120b-cloud", size: 384 },
			{ name: "eight-1.0-q3:14b", size: 9_000_000_000 },
		];
		expect(pickModel(installed)).toBe("eight-1.0-q3:14b");
		expect(pickModel([{ name: "gpt-oss:120b-cloud", size: 384 }])).toBeNull();
		expect(pickModel(installed, "gpt-oss:120b-cloud")).toBe("eight-1.0-q3:14b");
	});

	test("the model list every picker reads has no cloud tags", async () => {
		const fake = (async () =>
			new Response(JSON.stringify({ models: [{ name: "a:1b" }, { name: "big:480b-cloud" }] }), {
				status: 200,
			})) as unknown as typeof fetch;
		const server = createOllamaServer({ baseUrl: "http://127.0.0.1:11434", fetch: fake });
		expect((await server.listModels()).map((m) => m.name)).toEqual(["a:1b"]);
	});

	test("the Ollama client refuses a cloud tag in chat and generate, and sends nothing", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const c = new OllamaClient("gpt-oss:120b-cloud", "http://127.0.0.1:11434");
		await expect(c.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/Ollama cloud model/);
		await expect(c.generate("hi")).rejects.toThrow(/Ollama cloud model/);
		expect(calls).toBe(0);
	});

	test("a local model still reaches the client", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const c = new OllamaClient("llama3.2:3b", "http://127.0.0.1:11434");
		await c.chat([{ role: "user", content: "hi" }]);
		expect(calls).toBe(1);
	});
});
