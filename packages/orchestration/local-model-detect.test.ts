/**
 * Tests for local-model-detect: param parsing and role recommendation.
 * Network probes are not exercised here - they are integration-tested by
 * `scripts/sync-local-roles.ts` against a real host.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../providers";
import {
	CONTEXT_WINDOW_FLOOR,
	type DetectedModel,
	capabilityToolMode,
	knownContextWindow,
	paramHint,
	providerSupportsJsonMode,
	recommendRoleConfig,
	resolveCapabilities,
} from "./local-model-detect";

// Minimal ProviderConfig fixtures — only the fields the resolver reads.
function cfg(over: Partial<ProviderConfig> & Pick<ProviderConfig, "name">): ProviderConfig {
	return {
		displayName: over.name,
		baseUrl: "http://localhost:1234/v1",
		apiKeyEnv: "",
		defaultModel: "test-model",
		models: ["test-model"],
		enabled: true,
		supportsTools: true,
		supportsStreaming: true,
		supportsVision: false,
		supportedThinkingLevels: [],
		...over,
	} as ProviderConfig;
}

describe("paramHint", () => {
	test("parses billions from common model ids", () => {
		expect(paramHint("qwen3.6:27b")).toBe(27);
		expect(paramHint("google/gemma-4-26b-a4b")).toBe(26);
		expect(paramHint("llama-3.1-70b-versatile")).toBe(70);
	});

	test("returns 0 for embedding models", () => {
		expect(paramHint("nomic-embed-text:latest")).toBe(0);
		expect(paramHint("text-embedding-nomic-embed-text-v1.5")).toBe(0);
	});

	test("returns 0 when no parameter hint is present", () => {
		expect(paramHint("phi-mini")).toBe(0);
		expect(paramHint("apple-foundationmodel")).toBe(0);
	});
});

describe("recommendRoleConfig", () => {
	test("returns null when nothing is detected", () => {
		expect(recommendRoleConfig([])).toBeNull();
	});

	test("strongest model takes orchestrator + qa, second takes engineer", () => {
		const models: DetectedModel[] = [
			{ provider: "ollama", model: "qwen3.6:27b", score: 27 },
			{ provider: "lmstudio", model: "google/gemma-4-26b-a4b", score: 26 },
			{ provider: "apple-foundation", model: "apple-foundationmodel", score: 3 },
		];
		const cfg = recommendRoleConfig(models);
		expect(cfg).not.toBeNull();
		expect(cfg?.orchestrator).toEqual({ provider: "ollama", model: "qwen3.6:27b" });
		expect(cfg?.engineer).toEqual({
			provider: "lmstudio",
			model: "google/gemma-4-26b-a4b",
		});
		expect(cfg?.qa).toEqual({ provider: "ollama", model: "qwen3.6:27b" });
		expect(cfg?.fallback).toEqual({
			provider: "apple-foundation",
			model: "apple-foundationmodel",
		});
	});

	test("fallback drops to the weakest model when Apple Foundation is absent", () => {
		const models: DetectedModel[] = [
			{ provider: "ollama", model: "qwen3.6:27b", score: 27 },
			{ provider: "lmstudio", model: "gemma-9b", score: 9 },
		];
		const cfg = recommendRoleConfig(models);
		expect(cfg?.fallback).toEqual({ provider: "lmstudio", model: "gemma-9b" });
	});

	test("a single detected model fills every role", () => {
		const models: DetectedModel[] = [{ provider: "ollama", model: "qwen3.6:27b", score: 27 }];
		const rc = recommendRoleConfig(models);
		expect(rc?.orchestrator.model).toBe("qwen3.6:27b");
		expect(rc?.engineer.model).toBe("qwen3.6:27b");
		expect(rc?.qa.model).toBe("qwen3.6:27b");
		expect(rc?.fallback.model).toBe("qwen3.6:27b");
	});
});

describe("capabilityToolMode", () => {
	const noEnv = {} as Record<string, string | undefined>;

	test("Ollama-served 8gent GGUF resolves to text-tools", () => {
		expect(capabilityToolMode(cfg({ name: "8gent" }), noEnv)).toBe("text");
		expect(capabilityToolMode(cfg({ name: "ollama" }), noEnv)).toBe("text");
		expect(capabilityToolMode(cfg({ name: "lmstudio" }), noEnv)).toBe("text");
	});

	test("cloud tool-native provider resolves to native", () => {
		expect(capabilityToolMode(cfg({ name: "anthropic" }), noEnv)).toBe("native");
		expect(capabilityToolMode(cfg({ name: "openrouter" }), noEnv)).toBe("native");
	});

	test("no-tool providers resolve to none, even under override", () => {
		expect(capabilityToolMode(cfg({ name: "apfel", supportsTools: false }), noEnv)).toBe("none");
		expect(
			capabilityToolMode(cfg({ name: "apple-foundation", supportsTools: false }), {
				EIGHT_TEXT_TOOLS: "1",
			}),
		).toBe("none");
	});

	test("EIGHT_TEXT_TOOLS override forces text or native", () => {
		expect(capabilityToolMode(cfg({ name: "anthropic" }), { EIGHT_TEXT_TOOLS: "1" })).toBe("text");
		expect(capabilityToolMode(cfg({ name: "8gent" }), { EIGHT_TEXT_TOOLS: "0" })).toBe("native");
	});
});

describe("resolveCapabilities", () => {
	const noEnv = {} as Record<string, string | undefined>;

	test("8gent GGUF: text tools, no json, local context, no vision", async () => {
		const caps = await resolveCapabilities(cfg({ name: "8gent", supportsVision: true }), {
			env: noEnv,
		});
		expect(caps.tools).toBe("text");
		expect(caps.json).toBe(false);
		expect(caps.contextWindow).toBe(32768);
		expect(caps.vision).toBe(true);
		expect(caps.source.tools).toBe("flag");
	});

	test("anthropic: native tools, json, large context, vision", async () => {
		const caps = await resolveCapabilities(cfg({ name: "anthropic", supportsVision: true }), {
			env: noEnv,
		});
		expect(caps.tools).toBe("native");
		expect(caps.json).toBe(true);
		expect(caps.contextWindow).toBe(200000);
		expect(caps.vision).toBe(true);
	});

	test("apfel: no tools, no json, floor context", async () => {
		const caps = await resolveCapabilities(cfg({ name: "apfel", supportsTools: false }), {
			env: noEnv,
		});
		expect(caps.tools).toBe("none");
		expect(caps.json).toBe(false);
		expect(caps.contextWindow).toBe(CONTEXT_WINDOW_FLOOR);
	});

	test("native probe returning false downgrades to text-tools", async () => {
		const caps = await resolveCapabilities(cfg({ name: "openrouter" }), {
			env: noEnv,
			probe: async () => false, // served template rejected the tools payload
		});
		expect(caps.tools).toBe("text");
		expect(caps.source.tools).toBe("probe");
	});

	test("native probe passing keeps native tools", async () => {
		const caps = await resolveCapabilities(cfg({ name: "openrouter" }), {
			env: noEnv,
			probe: async () => true,
		});
		expect(caps.tools).toBe("native");
		expect(caps.source.tools).toBe("flag");
	});

	test("context lookup from endpoint overrides the known default", async () => {
		const caps = await resolveCapabilities(cfg({ name: "anthropic" }), {
			env: noEnv,
			contextLookup: async () => 500000,
		});
		expect(caps.contextWindow).toBe(500000);
		expect(caps.source.context).toBe("endpoint");
	});
});

describe("knownContextWindow / providerSupportsJsonMode", () => {
	test("known providers report a window, unknowns get the floor", () => {
		expect(knownContextWindow(cfg({ name: "anthropic" }))).toBe(200000);
		expect(knownContextWindow(cfg({ name: "8gent" }))).toBe(32768);
		expect(knownContextWindow(cfg({ name: "replicate" }))).toBe(CONTEXT_WINDOW_FLOOR);
	});

	test("json mode support tracks the structured-output provider set", () => {
		expect(providerSupportsJsonMode(cfg({ name: "anthropic" }))).toBe(true);
		expect(providerSupportsJsonMode(cfg({ name: "openrouter" }))).toBe(true);
		expect(providerSupportsJsonMode(cfg({ name: "8gent" }))).toBe(false);
		expect(providerSupportsJsonMode(cfg({ name: "apfel" }))).toBe(false);
	});
});

// ── Law 2 (issue #2747): only tool-capable models do tool-work ──────────────

import { probeToolCapability, scoreForAgentic } from "./local-model-detect";

describe("probeToolCapability", () => {
	const fetch400 = (async () =>
		new Response(JSON.stringify({ error: "cannot accept tools: jinja template error" }), {
			status: 400,
		})) as unknown as typeof fetch;
	const fetch200 = (async () =>
		new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
			status: 200,
		})) as unknown as typeof fetch;
	const fetchDown = (async () => {
		throw new Error("fetch failed");
	}) as unknown as typeof fetch;

	test("a 400 on the tools probe marks the model NOT tool-capable", async () => {
		expect(
			await probeToolCapability("lmstudio", "gemma-4-12b-coder-fable5-composer2.5-v1", {
				fetchImpl: fetch400,
			}),
		).toBe("none");
	});

	test("a 200 marks the model tool-capable", async () => {
		expect(await probeToolCapability("lmstudio", "ornith-1.0-9b", { fetchImpl: fetch200 })).toBe(
			"native",
		);
	});

	test("an unreachable endpoint is 'unknown' - never demotes on uncertainty", async () => {
		expect(await probeToolCapability("lmstudio", "ornith-1.0-9b", { fetchImpl: fetchDown })).toBe(
			"unknown",
		);
	});

	test("apple-foundation is never probed over HTTP", async () => {
		expect(
			await probeToolCapability("apple-foundation", "apple-foundationmodel", {
				fetchImpl: fetchDown,
			}),
		).toBe("unknown");
	});

	// ── #2894: a hang is not uncertainty ──────────────────────────────────
	test("a model that never answers the tools probe is 'none', not 'unknown'", async () => {
		// qwen3.8:27b-mlx advertises capabilities:["tools"] and never returns.
		// "unknown" is deliberately never demoted, so returning it here handed
		// the model straight back to the router, which sent another tools
		// payload, which hung again. Measured 2026-08-28: no answer in 15s.
		const fetchHang = (async () => {
			const e = new Error("The operation timed out.");
			e.name = "TimeoutError";
			throw e;
		}) as unknown as typeof fetch;

		expect(
			await probeToolCapability("ollama", "qwen3.8:27b-mlx", {
				fetchImpl: fetchHang,
				timeoutMs: 50,
			}),
		).toBe("none");
	});

	test("a refused connection is still 'unknown' - only hangs demote", async () => {
		// The distinction that makes the above safe: a provider that is simply
		// down must not be permanently marked tool-incapable.
		expect(await probeToolCapability("ollama", "llama3.2:3b", { fetchImpl: fetchDown })).toBe(
			"unknown",
		);
	});
});

describe("recommendRoleConfig with tool capability (Law 2)", () => {
	test("a bigger model that rejects tools is NOT chosen for tool roles", () => {
		const models: DetectedModel[] = [
			// gemma: highest param score but 400s on a tools payload.
			{
				provider: "lmstudio",
				model: "gemma-4-12b-coder-fable5-composer2.5-v1",
				score: 12,
				toolCapable: false,
			},
			{ provider: "lmstudio", model: "ornith-1.0-9b", score: 9, toolCapable: true },
		];
		const cfg = recommendRoleConfig(models);
		expect(cfg?.orchestrator.model).toBe("ornith-1.0-9b");
		expect(cfg?.engineer.model).toBe("ornith-1.0-9b");
		expect(cfg?.qa.model).toBe("ornith-1.0-9b");
	});

	test("falls back to the full pool when NO candidate is tool-capable", () => {
		const models: DetectedModel[] = [
			{ provider: "lmstudio", model: "gemma-broken", score: 12, toolCapable: false },
		];
		const cfg = recommendRoleConfig(models);
		expect(cfg?.orchestrator.model).toBe("gemma-broken");
	});
});

describe("scoreForAgentic", () => {
	test("a tools-rejecting model scores 0 for agentic work regardless of size", () => {
		expect(
			scoreForAgentic({ provider: "lmstudio", model: "gemma-12b", score: 12, toolCapable: false }),
		).toBe(0);
		expect(
			scoreForAgentic({
				provider: "lmstudio",
				model: "ornith-1.0-9b",
				score: 9,
				toolCapable: true,
			}),
		).toBe(9);
	});
});
