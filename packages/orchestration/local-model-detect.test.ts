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
