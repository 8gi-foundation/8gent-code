import { describe, expect, test } from "bun:test";
import { resolveOllamaBaseUrl } from "../ai/text-tool-endpoint";
import { resolveOllamaHost } from "../decide/backends/ollama";

// Every shape of OLLAMA_HOST / OLLAMA_BASE_URL a person might set. Chat (packages/ai)
// and System One (packages/decide) must land on the same server for each (#3149).
const CASES: Array<[Record<string, string | undefined>, string]> = [
	[{}, "http://localhost:11434"],
	[{ OLLAMA_HOST: "gpu-box" }, "http://gpu-box:11434"],
	[{ OLLAMA_HOST: "gpu-box/" }, "http://gpu-box:11434"],
	[{ OLLAMA_HOST: "0.0.0.0:11434" }, "http://0.0.0.0:11434"],
	[{ OLLAMA_HOST: "127.0.0.1:21434" }, "http://127.0.0.1:21434"],
	[{ OLLAMA_HOST: "http://box:1/" }, "http://box:1"],
	[{ OLLAMA_BASE_URL: "http://gpu:11434/v1/" }, "http://gpu:11434"],
	[{ OLLAMA_BASE_URL: "http://127.0.0.1:21434", OLLAMA_HOST: "other:1" }, "http://127.0.0.1:21434"],
	[{ OLLAMA_BASE_URL: "  ", OLLAMA_HOST: "box:2" }, "http://box:2"],
	[{ OLLAMA_BASE_URL: "gpu-box" }, "http://gpu-box:11434"],
];

describe("one Ollama host resolver", () => {
	for (const [env, want] of CASES) {
		test(`${JSON.stringify(env)} -> ${want}, for chat and System One alike`, () => {
			expect(resolveOllamaBaseUrl(env)).toBe(want);
			expect(resolveOllamaHost(env)).toBe(want);
		});
	}
});
