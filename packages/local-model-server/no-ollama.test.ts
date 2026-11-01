/**
 * With EIGHT_LOCAL_SERVER=llama-server, nothing asks Ollama (#3149, phase 2).
 *
 * A sentinel HTTP server stands in for Ollama (OLLAMA_HOST / OLLAMA_BASE_URL
 * point at it) and counts every request. Each gate is tested twice: without
 * the flag the sentinel IS reached (so the test can see a leak), with it the
 * sentinel is never reached. A second fake plays llama-server.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProviders } from "../../apps/tui/src/lib/provider-health";
import { localProviderEndpoints } from "../../apps/tui/src/lib/provider-readiness";
import { providerToRuntime } from "../../apps/tui/src/lib/model-selection";
import { TaskRouter } from "../ai/task-router";
import { resolveTextToolEndpoint } from "../ai/text-tool-endpoint";
import { resolveGguf } from "../decide/backends/llamacpp";
import { detectBackend } from "../decide/probe";
import { shouldUseTextTools } from "../eight/agent";
import { createClient, runtimeForProvider } from "../eight/clients";
import { capabilityToolMode } from "../orchestration/local-model-detect";
import { getProviderManager } from "../providers";
import { probeOllama } from "../self-autonomy/onboarding";

type Hit = { path: string };
let ollamaHits: Hit[] = [];
let llamaHits: Hit[] = [];
let sentinel: ReturnType<typeof Bun.serve>;
let llama: ReturnType<typeof Bun.serve>;
let OLLAMA = "";
let LLAMA = "";
let CLOSED = "";

beforeAll(() => {
	sentinel = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			ollamaHits.push({ path: new URL(req.url).pathname });
			return Response.json({ models: [{ name: "eight-1.0-q3:14b", size: 9 }, { name: "qwen3.5:latest", size: 1 }] });
		},
	});
	llama = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const path = new URL(req.url).pathname;
			llamaHits.push({ path });
			if (path === "/health") return Response.json({ status: "ok" });
			if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "gguf-model" }] });
			return new Response("no", { status: 404 });
		},
	});
	OLLAMA = `http://127.0.0.1:${sentinel.port}`;
	LLAMA = `http://127.0.0.1:${llama.port}`;
	const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	CLOSED = `http://127.0.0.1:${closed.port}`;
	closed.stop(true);
});
afterAll(() => {
	sentinel.stop(true);
	llama.stop(true);
});

const KEYS = ["EIGHT_LOCAL_SERVER", "LLAMA_SERVER_URL", "OLLAMA_HOST", "OLLAMA_BASE_URL", "APFEL_BASE_URL", "LM_STUDIO_HOST"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

/** Point this process at the fakes, with or without the flag, and reset the counters. */
function world(flag: boolean): Record<string, string> {
	const env: Record<string, string> = {
		OLLAMA_HOST: OLLAMA,
		OLLAMA_BASE_URL: OLLAMA,
		LLAMA_SERVER_URL: LLAMA,
		APFEL_BASE_URL: CLOSED,
		LM_STUDIO_HOST: CLOSED,
	};
	if (flag) env.EIGHT_LOCAL_SERVER = "llama-server";
	for (const k of KEYS) delete process.env[k];
	Object.assign(process.env, env);
	ollamaHits = [];
	llamaHits = [];
	return env;
}

describe("onboarding: probeOllama", () => {
	test("without the flag it asks Ollama", async () => {
		const env = world(false);
		expect((await probeOllama({ env, timeoutMs: 2000 })).status).toBe("found");
		expect(ollamaHits.length).toBe(1);
	});
	test("with llama-server selected it never asks, and reports an unconfigured miss the welcome leaves out", async () => {
		const env = world(true);
		const check = await probeOllama({ env, timeoutMs: 2000 });
		expect(ollamaHits).toEqual([]);
		expect(check).toMatchObject({ status: "unreachable", configured: false, timedOut: false });
	});
});

describe("System One: detectBackend", () => {
	const opts = (env: Record<string, string>) => ({
		env: { ...env, LAYA_URL: CLOSED, HOME: "/nonexistent-home" },
		llamacppLoader: null,
		timeoutMs: 2000,
	});
	test("without the flag it lists Ollama models", async () => {
		const r = await detectBackend(opts(world(false)));
		expect(r.backend).toBe("ollama");
		expect(ollamaHits.map((h) => h.path)).toEqual(["/api/tags"]);
	});
	test("with llama-server selected it never asks Ollama", async () => {
		const r = await detectBackend(opts(world(true)));
		expect(r.backend).toBe("none");
		expect(ollamaHits).toEqual([]);
		expect(r.notes.join(" ")).toContain("EIGHT_LOCAL_SERVER");
	});
});

describe("System One: GGUF without Ollama", () => {
	test("finds a GGUF in $HOME/.8gent/models/decide with no Ollama store at all", () => {
		const home = mkdtempSync(join(tmpdir(), "decide-home-"));
		try {
			const dir = join(home, ".8gent", "models", "decide");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "llama3.2-3b.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
			writeFileSync(join(dir, "notes.gguf"), "not a gguf");
			const r = resolveGguf({ HOME: home, OLLAMA_MODELS: join(home, "no-store") });
			expect(r).toMatchObject({ path: join(dir, "llama3.2-3b.gguf"), model: "llama3.2-3b", source: "local" });
			expect(resolveGguf({ HOME: home }, "llama3.2-3b")).toMatchObject({ model: "llama3.2-3b", source: "local" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("task router", () => {
	test("without the flag, route() classifies on Ollama", async () => {
		world(false);
		await new TaskRouter({ enabled: true, classifierProvider: "ollama" }).route("fix the bug");
		expect(ollamaHits.length).toBeGreaterThan(0);
	});
	test("with llama-server selected, route() and autoAssign() never ask Ollama and never switch the model", async () => {
		world(true);
		const router = new TaskRouter({ enabled: true, classifierProvider: "ollama" });
		const decision = await router.route("fix the bug");
		expect(await router.autoAssign()).toEqual([]);
		expect(ollamaHits).toEqual([]);
		expect(decision.confidence).toBe(0);
	});
});

describe("TUI: health and readiness", () => {
	test("without the flag the health probe reads Ollama", async () => {
		world(false);
		const { statuses } = await probeProviders();
		expect(statuses.map((s) => s.name)).toContain("ollama");
		expect(ollamaHits.map((h) => h.path)).toEqual(["/api/tags"]);
	});
	test("with llama-server selected, the health probe reads llama-server's /health instead", async () => {
		world(true);
		const { statuses } = await probeProviders();
		expect(ollamaHits).toEqual([]);
		expect(statuses.find((s) => s.name === "llama-server")?.live).toBe(true);
		expect(llamaHits.map((h) => h.path)).toEqual(["/health"]);
	});
	test("readiness endpoints: llama-server first, no Ollama", () => {
		const eps = localProviderEndpoints(world(true));
		expect(eps.map((e) => e.provider)).toEqual(["llama-server", "lmstudio"]);
		expect(eps[0].modelsUrl).toBe(`${LLAMA}/v1/models`);
		expect(eps.some((e) => e.modelsUrl.includes("/api/tags"))).toBe(false);
	});
});

describe("llama-server as a provider", () => {
	test("is a known provider, runs on the text-tool path, and maps to its own runtime", () => {
		expect(getProviderManager().isKnownProvider("llama-server")).toBe(true);
		expect(providerToRuntime("llama-server")).toBe("llama-server");
		expect(runtimeForProvider("llama-server")).toBe("llama-server");
		expect(shouldUseTextTools("llama-server")).toBe(true);
		expect(capabilityToolMode({ name: "llama-server", supportsTools: true }, {})).toBe("text");
	});
	test("text-tool steps and the readiness client go to LLAMA_SERVER_URL, never Ollama", async () => {
		world(true);
		expect(resolveTextToolEndpoint("llama-server")).toBe(`${LLAMA}/v1/chat/completions`);
		expect(await createClient({ runtime: "llama-server", model: "gguf-model" }).isAvailable()).toBe(true);
		expect(llamaHits.map((h) => h.path)).toEqual(["/v1/models"]);
		expect(ollamaHits).toEqual([]);
	});
});
