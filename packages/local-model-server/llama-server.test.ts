import { describe, expect, test } from "bun:test";
import { localModelServerContract } from "./contract";
import {
	DEFAULT_LLAMA_SERVER_URL,
	LLAMA_SERVER_CAPABILITIES,
	LocalServerResponseError,
	createLlamaServer,
	isLlamaServerSelected,
	isOllamaEnabled,
	resolveLlamaServerUrl,
	resolveLocalServerKind,
} from "./index";

// The same contract the Ollama adapter passes, against a fake speaking llama-server's dialect:
// GET /v1/models answers { object, data: [{ id, ... }] } and GET /health answers 200.
localModelServerContract({
	kind: "llama-server",
	create: (baseUrl, fetch) => createLlamaServer({ baseUrl, fetch }),
	answer: (pathname, models) => {
		if (pathname === "/v1/models")
			return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "llamacpp" })) });
		if (pathname === "/health") return Response.json({ status: "ok" });
		return null;
	},
});

describe("llama-server adapter specifics", () => {
	test("capabilities state what llama-server cannot do: no pull, no MLX, one model per process", () => {
		expect(LLAMA_SERVER_CAPABILITIES.pull).toBe(false);
		expect(LLAMA_SERVER_CAPABILITIES.mlx).toBe(false);
		expect(LLAMA_SERVER_CAPABILITIES.multiModel).toBe(false);
		expect(LLAMA_SERVER_CAPABILITIES.openaiChat).toBe(true);
		expect(LLAMA_SERVER_CAPABILITIES.rawPrompt).toBe(true);
	});

	test("model list reads /v1/models, health reads /health", () => {
		const s = createLlamaServer({ baseUrl: "http://h:8080" });
		expect(s.modelsUrl).toBe("http://h:8080/v1/models");
		expect(s.healthUrl).toBe("http://h:8080/health");
	});

	test("reads the answer a real llama-server (b7480) gives, which also carries an Ollama-style `models`", async () => {
		// Captured from llama-server 7480 serving one GGUF with --alias llama3.2-3b.
		const real = {
			models: [{ name: "llama3.2-3b", model: "llama3.2-3b", details: { format: "gguf" } }],
			object: "list",
			data: [{ id: "llama3.2-3b", object: "model", created: 1, owned_by: "llamacpp", meta: { n_ctx_train: 131072 } }],
		};
		const s = createLlamaServer({ baseUrl: "http://h", fetch: async () => Response.json(real) });
		const [m] = await s.listModels();
		expect(m.name).toBe("llama3.2-3b");
		expect(m.owned_by).toBe("llamacpp");
	});

	test("skips entries without an id; a non-list `data` is a response error", async () => {
		const withBody = (body: unknown) =>
			createLlamaServer({ baseUrl: "http://h", fetch: async () => Response.json(body) }).listModels();
		expect((await withBody({ data: [{ id: "a" }, { object: "model" }, { id: "" }] })).map((m) => m.name)).toEqual(["a"]);
		expect(await withBody({})).toEqual([]);
		expect(await withBody({ data: { id: "a" } }).catch((e) => e)).toBeInstanceOf(LocalServerResponseError);
	});
});

describe("EIGHT_LOCAL_SERVER selection", () => {
	test("unset, blank or unknown means Ollama, today's behaviour", () => {
		for (const v of [undefined, "", "  ", "vllm", "ollama", "OLLAMA"]) {
			expect(resolveLocalServerKind({ EIGHT_LOCAL_SERVER: v })).toBe("ollama");
			expect(isOllamaEnabled({ EIGHT_LOCAL_SERVER: v })).toBe(true);
		}
	});

	test("llama-server turns Ollama off", () => {
		for (const v of ["llama-server", "LLAMA_SERVER", " llama-server "]) {
			expect(isLlamaServerSelected({ EIGHT_LOCAL_SERVER: v })).toBe(true);
			expect(isOllamaEnabled({ EIGHT_LOCAL_SERVER: v })).toBe(false);
		}
	});

	test("LLAMA_SERVER_URL: default, bare host:port, trailing /v1 and slash", () => {
		expect(resolveLlamaServerUrl({})).toBe(DEFAULT_LLAMA_SERVER_URL);
		expect(resolveLlamaServerUrl({ LLAMA_SERVER_URL: "127.0.0.1:18080" })).toBe("http://127.0.0.1:18080");
		expect(resolveLlamaServerUrl({ LLAMA_SERVER_URL: "http://gpu:8080/v1/" })).toBe("http://gpu:8080");
	});
});
