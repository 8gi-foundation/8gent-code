import { describe, expect, test } from "bun:test";
import { createLlamaRouter } from "../../../../packages/local-model-server/llama-router.js";
import { runLlamaCommand, switchModelInPlace } from "./llama-command.js";
import { canReuseTabAgent } from "./model-selection.js";

/**
 * A stub router-mode llama-server with two presets, one loaded. Records every request.
 * Like the real router (b11146), POST /models/load answers at once and the model's
 * status moves to `afterLoad` on the next GET /models.
 */
function server(
	over: Record<string, () => Response> = {},
	afterLoad: object = { value: "loaded" },
) {
	const calls: string[] = [];
	const state: Record<string, object> = {
		"qwen-27b": { value: "loaded" },
		"gemma-4b": { value: "unloaded" },
	};
	const routes: Record<string, (body?: { model?: string }) => Response> = {
		"GET /health": () => Response.json({ status: "ok" }),
		"GET /models": () =>
			Response.json({ data: Object.entries(state).map(([id, status]) => ({ id, status })) }),
		"GET /props?model=qwen-27b&autoload=false": () =>
			Response.json({ default_generation_settings: { n_ctx: 65536 }, is_sleeping: false }),
		"GET /metrics?model=qwen-27b&autoload=false": () =>
			new Response("llamacpp:predicted_tokens_seconds 38.25\nllamacpp:requests_processing 1\n"),
		"POST /models/load": (body) => {
			if (body?.model) state[body.model] = afterLoad;
			return Response.json({ success: true });
		},
		"POST /models/unload": () => Response.json({ success: true }),
		...over,
	};
	const fetch = async (input: string, init?: RequestInit) => {
		const u = new URL(input);
		const key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`;
		calls.push(key);
		const r = routes[key];
		return r
			? r(init?.body ? JSON.parse(String(init.body)) : undefined)
			: new Response("", { status: 404 });
	};
	return {
		calls,
		router: createLlamaRouter({
			baseUrl: "http://127.0.0.1:8080",
			fetch,
			pollMs: 0,
			loadTimeoutMs: 1_000,
		}),
	};
}

const ctx = (router: ReturnType<typeof server>["router"], currentProvider = "llama-server") => ({
	router,
	currentModel: "qwen-27b",
	currentProvider,
});

describe("/llama status", () => {
	test("shows health, router mode, loaded models, context and metrics for the current model", async () => {
		const { message } = await runLlamaCommand("llama", [], ctx(server().router));
		expect(message).toContain("health: ok");
		expect(message).toContain("mode: router (switch per request)");
		expect(message).toContain("loaded: qwen-27b");
		expect(message).toContain("context: 65536 tokens");
		expect(message).toContain("generate 38.3 tok/s");
		expect(message).toContain("busy 1");
		expect(message).toContain("nvidia-smi");
	});

	test("a server that is down says so in one line and stops", async () => {
		const dead = createLlamaRouter({
			baseUrl: "http://127.0.0.1:8080",
			fetch: async () => {
				throw new TypeError("refused");
			},
		});
		const { message } = await runLlamaCommand("llama", ["status"], ctx(dead));
		expect(message).toContain("health: down (not reachable at http://127.0.0.1:8080 (refused))");
		expect(message).not.toContain("mode:");
	});

	test("metrics off is named, not an error", async () => {
		const { message } = await runLlamaCommand(
			"llama",
			[],
			ctx(
				server({
					"GET /metrics?model=qwen-27b&autoload=false": () => new Response("", { status: 501 }),
				}).router,
			),
		);
		expect(message).toContain("metrics: off (start llama-server with --metrics)");
	});
});

describe("/llama load and unload", () => {
	test("call the documented endpoints and report the server's refusal", async () => {
		const s = server({
			"POST /models/unload": () =>
				Response.json({ error: { message: "model not found" } }, { status: 400 }),
		});
		expect((await runLlamaCommand("llama", ["load", "gemma-4b"], ctx(s.router))).message).toBe(
			"Loaded gemma-4b.",
		);
		expect((await runLlamaCommand("llama", ["unload", "nope"], ctx(s.router))).message).toBe(
			"llama-server could not unload nope: model not found",
		);
		expect((await runLlamaCommand("llama", ["load"], ctx(s.router))).message).toBe(
			"Usage: /llama load <id>",
		);
	});
});

describe("/models", () => {
	test("lists ids with status and marks the current one", async () => {
		const { message, useModel } = await runLlamaCommand("models", [], ctx(server().router));
		expect(message).toContain("* qwen-27b  loaded");
		expect(message).toContain("  gemma-4b  unloaded");
		expect(useModel).toBeUndefined();
	});

	test("use <id> loads an unloaded router model first, then returns the id to switch to", async () => {
		const s = server();
		const r = await runLlamaCommand("models", ["use", "gemma-4b"], ctx(s.router));
		expect(r).toEqual({ message: "Model switched to gemma-4b.", useModel: "gemma-4b" });
		expect(s.calls).toContain("POST /models/load");
	});

	test("use <id> on a loaded model does not reload it", async () => {
		const s = server();
		expect((await runLlamaCommand("models", ["use", "qwen-27b"], ctx(s.router))).useModel).toBe(
			"qwen-27b",
		);
		expect(s.calls).not.toContain("POST /models/load");
	});

	test("a load the server refuses keeps the session on its model, with the reason", async () => {
		const s = server({
			"POST /models/load": () =>
				Response.json(
					{ error: { message: "failed to load model: out of memory" } },
					{ status: 500 },
				),
		});
		const r = await runLlamaCommand("models", ["use", "gemma-4b"], ctx(s.router));
		expect(r.useModel).toBeUndefined();
		expect(r.message).toBe(
			"llama-server could not load gemma-4b: failed to load model: out of memory. Still on qwen-27b.",
		);
	});

	test("a load the server accepts but the model process then fails is reported, not switched (seen live)", async () => {
		const s = server({}, { value: "unloaded", failed: true, exit_code: 1 });
		const r = await runLlamaCommand("models", ["use", "gemma-4b"], ctx(s.router));
		expect(r.useModel).toBeUndefined();
		expect(r.message).toBe(
			"llama-server could not load gemma-4b: the model process exited with code 1; the llama-server window has the reason. Still on qwen-27b.",
		);
	});

	test("status never asks about an unloaded model, so it never starts a load", async () => {
		const s = server();
		await runLlamaCommand("llama", [], { ...ctx(s.router), currentModel: "gemma-4b" });
		expect(s.calls).toContain("GET /props?model=qwen-27b&autoload=false");
		expect(s.calls.some((c) => c.includes("gemma-4b") || c.startsWith("POST"))).toBe(false);
	});

	test("an unknown id, a missing id, a down server or another provider never switch", async () => {
		const s = server();
		const unknown = await runLlamaCommand("models", ["use", "nope"], ctx(s.router));
		expect(unknown.useModel).toBeUndefined();
		expect(unknown.message).toContain("Ids: qwen-27b, gemma-4b");
		expect((await runLlamaCommand("models", ["use"], ctx(s.router))).useModel).toBeUndefined();
		const other = await runLlamaCommand("models", ["use", "gemma-4b"], ctx(s.router, "ollama"));
		expect(other.useModel).toBeUndefined();
		expect(other.message).toContain("/provider llama-server");
		const dead = createLlamaRouter({
			baseUrl: "http://127.0.0.1:8080",
			fetch: async () => {
				throw new TypeError("refused");
			},
		});
		const down = await runLlamaCommand("models", ["use", "gemma-4b"], ctx(dead));
		expect(down.useModel).toBeUndefined();
		expect(down.message).toContain("Still on qwen-27b");
	});
});

describe("switchModelInPlace", () => {
	test("the live session takes the new model and the rebuild check reuses it, so history stays", () => {
		const built = new WeakMap<object, { model: string; runtime: string }>();
		const history = ["user: hi", "assistant: hello"];
		const live = {
			model: "qwen-27b",
			history,
			setModel(m: string) {
				this.model = m;
			},
		};
		built.set(live, { model: "qwen-27b", runtime: "llama-server" });
		expect(switchModelInPlace(live, built, "gemma-4b", "llama-server")).toBe(true);
		expect(live.model).toBe("gemma-4b");
		expect(live.history).toBe(history);
		// The TUI's rebuild effect drops the session unless this holds (app.tsx initAgent).
		expect(
			canReuseTabAgent(built.get(live) ?? {}, { model: "gemma-4b", runtime: "llama-server" }),
		).toBe(true);
	});

	test("no live session: nothing to keep", () => {
		expect(switchModelInPlace(null, new WeakMap(), "gemma-4b", "llama-server")).toBe(false);
	});
});
