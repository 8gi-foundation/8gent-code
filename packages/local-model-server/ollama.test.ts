import { describe, expect, test } from "bun:test";
import { localModelServerContract } from "./contract";
import { LocalServerResponseError, createOllamaServer, ollamaCapabilities } from "./index";

localModelServerContract({
	kind: "ollama",
	create: (baseUrl, fetch) => createOllamaServer({ baseUrl, fetch }),
	answer: (pathname, models) =>
		pathname === "/api/tags" ? Response.json({ models: models.map((name) => ({ name, model: name, size: 1 })) }) : null,
});

describe("Ollama adapter specifics", () => {
	test("MLX only on Apple Silicon macOS", () => {
		expect(ollamaCapabilities({ platform: "darwin", arch: "arm64" }).mlx).toBe(true);
		expect(ollamaCapabilities({ platform: "darwin", arch: "x64" }).mlx).toBe(false);
		expect(ollamaCapabilities({ platform: "linux", arch: "arm64" }).mlx).toBe(false);
		expect(ollamaCapabilities({ platform: "win32", arch: "x64" }).mlx).toBe(false);
	});

	test("model list and health are the same /api/tags read", () => {
		const s = createOllamaServer({ baseUrl: "http://h:11434" });
		expect(s.modelsUrl).toBe("http://h:11434/api/tags");
		expect(s.healthUrl).toBe(s.modelsUrl);
	});

	test("keeps every field Ollama sends, so callers can rank by size", async () => {
		const entry = { name: "q:1b", model: "q:1b", size: 42, digest: "d", details: { family: "qwen3" } };
		const s = createOllamaServer({
			baseUrl: "http://h",
			fetch: async () => Response.json({ models: [entry] }),
		});
		expect(await s.listModels()).toEqual([entry]);
	});

	test("a missing or null `models` is an empty list; a non-list or non-object body is a response error", async () => {
		const withBody = (body: unknown) =>
			createOllamaServer({ baseUrl: "http://h", fetch: async () => Response.json(body) }).listModels();
		expect(await withBody({})).toEqual([]);
		expect(await withBody({ models: null })).toEqual([]);
		expect(await withBody({ models: { name: "x" } }).catch((e) => e)).toBeInstanceOf(LocalServerResponseError);
		expect(await withBody(null).catch((e) => e)).toBeInstanceOf(LocalServerResponseError);
		expect(await withBody(5).catch((e) => e)).toBeInstanceOf(LocalServerResponseError);
	});
});
