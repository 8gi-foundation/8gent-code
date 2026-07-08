/**
 * Tests for local-model-detect: param parsing and role recommendation.
 * Network probes are not exercised here - they are integration-tested by
 * `scripts/sync-local-roles.ts` against a real host.
 */

import { describe, expect, test } from "bun:test";
import { type DetectedModel, paramHint, recommendRoleConfig } from "./local-model-detect";

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
		const cfg = recommendRoleConfig(models);
		expect(cfg?.orchestrator.model).toBe("qwen3.6:27b");
		expect(cfg?.engineer.model).toBe("qwen3.6:27b");
		expect(cfg?.qa.model).toBe("qwen3.6:27b");
		expect(cfg?.fallback.model).toBe("qwen3.6:27b");
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
