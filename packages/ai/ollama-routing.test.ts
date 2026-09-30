/**
 * #3080: with ollama configured remote (OLLAMA_BASE_URL / OLLAMA_HOST), the
 * TUI still sent one POST /v1/chat/completions to localhost:11434 at every turn
 * start: the task router's classify goes through createModel, whose ollama
 * default was a hardcoded localhost. TaskRouter.autoAssign probed
 * localhost:11434/api/tags the same way. Both now use resolveOllamaBaseUrl.
 *
 * fetch is stubbed (the suite sandbox cannot bind sockets); the real
 * createModel / AI SDK / TaskRouter code builds and sends each request.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { generateText } from "ai";
import { createModel, defaultBaseUrl } from "./providers";
import { TaskRouter } from "./task-router";

const realFetch = globalThis.fetch;
const KEYS = ["OLLAMA_BASE_URL", "OLLAMA_HOST"] as const;
let saved: Array<readonly [string, string | undefined]> = [];

function setEnv(vars: Partial<Record<(typeof KEYS)[number], string>>): void {
	saved = KEYS.map((k) => [k, process.env[k]] as const);
	for (const k of KEYS) Reflect.deleteProperty(process.env, k);
	Object.assign(process.env, vars);
}

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const [k, v] of saved) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	saved = [];
});

function recordUrls(): string[] {
	const urls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		urls.push(typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input)));
		return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
	}) as unknown as typeof fetch;
	return urls;
}

describe("ollama default base URL follows the env (#3080)", () => {
	it("defaultBaseUrl('ollama') uses OLLAMA_BASE_URL, then OLLAMA_HOST, then localhost", () => {
		setEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434" });
		expect(defaultBaseUrl("ollama")).toBe("http://127.0.0.1:21434/v1");
		setEnv({ OLLAMA_HOST: "10.0.0.5:11434" });
		expect(defaultBaseUrl("ollama")).toBe("http://10.0.0.5:11434/v1");
		setEnv({});
		expect(defaultBaseUrl("ollama")).toBe("http://localhost:11434/v1");
		expect(defaultBaseUrl("lmstudio")).toBe("http://localhost:1234/v1");
	});

	it("createModel for ollama sends its request to the env host", async () => {
		setEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434" });
		const urls = recordUrls();
		const model = createModel({ name: "ollama", model: "m" });
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => undefined);
		expect(urls).toEqual(["http://127.0.0.1:21434/v1/chat/completions"]);
	});

	it("an explicit baseURL still wins", async () => {
		setEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434" });
		const urls = recordUrls();
		const model = createModel({ name: "ollama", model: "m", baseURL: "http://pinned:9/v1" });
		await generateText({ model, prompt: "hi", maxRetries: 0 }).catch(() => undefined);
		expect(urls).toEqual(["http://pinned:9/v1/chat/completions"]);
	});

	it("the task router's per-turn classify goes to the env host, not localhost", async () => {
		setEnv({ OLLAMA_HOST: "127.0.0.1:21434" });
		const urls = recordUrls();
		const router = new TaskRouter({ enabled: true, classifierProvider: "ollama", classifierModel: "qwen3.5:latest" });
		await router.classify("Fix the failing toCelsius test").catch(() => undefined);
		expect(urls.length).toBeGreaterThan(0);
		for (const u of urls) expect(u).toBe("http://127.0.0.1:21434/v1/chat/completions");
	});

	it("autoAssign probes the env host's /api/tags", async () => {
		setEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434" });
		const urls = recordUrls();
		await new TaskRouter({ enabled: true }).autoAssign();
		expect(urls).toEqual(["http://127.0.0.1:21434/api/tags"]);
	});
});
