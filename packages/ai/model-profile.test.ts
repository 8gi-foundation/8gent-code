/**
 * ModelProfile type tests — TDD: written BEFORE implementation.
 *
 * Covers: getProfile, scoreModelForTask, MODEL_PROFILES registry,
 * glob matching, strength/weakness validation.
 */

import { describe, it, expect } from "bun:test";
import {
  type StrengthArea,
  type ModelProfile,
  MODEL_PROFILES,
  getProfile,
  scoreModelForTask,
} from "./model-profile.js";
import type { ProviderConfig } from "./providers.js";

// ── helpers ──────────────────────────────────────────────────────────

const VALID_STRENGTH_AREAS: StrengthArea[] = [
  "code-generation",
  "code-review",
  "debugging",
  "conversation",
  "empathy",
  "creative-writing",
  "reasoning",
  "math",
  "analysis",
  "summarization",
  "extraction",
  "translation",
  "tool-use",
  "instruction-following",
];

function ollamaConfig(model: string): ProviderConfig {
  return { name: "ollama", model };
}

// ── getProfile ───────────────────────────────────────────────────────

describe("getProfile", () => {
  it("returns a profile for qwen3:32b on ollama", () => {
    const profile = getProfile(ollamaConfig("qwen3:32b"));
    expect(profile).toBeDefined();
    expect(profile!.displayName).toContain("Qwen");
    expect(profile!.provider).toBe("ollama");
  });

  it("returns undefined for an unknown model", () => {
    const profile = getProfile(ollamaConfig("totally-unknown-model-xyz"));
    expect(profile).toBeUndefined();
  });

  it("matches glob patterns (llama-3.3* matches llama-3.3-70b-versatile)", () => {
    const config: ProviderConfig = { name: "openrouter", model: "llama-3.3-70b-versatile" };
    const profile = getProfile(config);
    expect(profile).toBeDefined();
    expect(profile!.modelPattern).toContain("llama-3.3");
  });
});

// ── MODEL_PROFILES registry ──────────────────────────────────────────

describe("MODEL_PROFILES", () => {
  it("has at least 3 entries", () => {
    expect(Object.keys(MODEL_PROFILES).length).toBeGreaterThanOrEqual(3);
  });

  it("all profiles have valid StrengthArea values (no typos)", () => {
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      for (const s of profile.strengths) {
        expect(VALID_STRENGTH_AREAS).toContain(s);
      }
      for (const w of profile.weaknesses) {
        expect(VALID_STRENGTH_AREAS).toContain(w);
      }
    }
  });

  it("no model has the same area in both strengths and weaknesses", () => {
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      const overlap = profile.strengths.filter((s) =>
        profile.weaknesses.includes(s),
      );
      expect(overlap).toEqual([]);
    }
  });
});

// ── scoreModelForTask ────────────────────────────────────────────────

describe("scoreModelForTask", () => {
  const codingProfile: ModelProfile = {
    modelPattern: "test-coder",
    displayName: "Test Coder",
    strengths: ["code-generation", "debugging", "reasoning"],
    weaknesses: ["empathy", "creative-writing"],
    contextWindow: 32_768,
    costTier: "free",
    speedTier: "fast",
    provider: "test",
  };

  it("returns high score when required strengths match profile strengths", () => {
    const score = scoreModelForTask(codingProfile, [
      "code-generation",
      "debugging",
      "reasoning",
    ]);
    // 3 matches * 0.2 = 0.6
    expect(score).toBeCloseTo(0.6, 5);
  });

  it("returns negative score when required strengths match profile weaknesses", () => {
    const score = scoreModelForTask(codingProfile, [
      "empathy",
      "creative-writing",
    ]);
    // 2 weakness matches * -0.2 = -0.4
    expect(score).toBeCloseTo(-0.4, 5);
  });

  it("returns 0 when there is no overlap", () => {
    const score = scoreModelForTask(codingProfile, [
      "summarization",
      "translation",
    ]);
    expect(score).toBe(0);
  });

  it("clamps result to max 1", () => {
    // 5+ strengths matching would exceed 1.0 without clamp
    const bigProfile: ModelProfile = {
      modelPattern: "big",
      displayName: "Big",
      strengths: [
        "code-generation",
        "code-review",
        "debugging",
        "reasoning",
        "math",
        "analysis",
      ],
      weaknesses: [],
      contextWindow: 128_000,
      costTier: "premium",
      speedTier: "slow",
      provider: "test",
    };
    const score = scoreModelForTask(bigProfile, [
      "code-generation",
      "code-review",
      "debugging",
      "reasoning",
      "math",
      "analysis",
    ]);
    // 6 * 0.2 = 1.2 -> clamped to 1
    expect(score).toBe(1);
  });

  it("clamps result to min -1", () => {
    const weakProfile: ModelProfile = {
      modelPattern: "weak",
      displayName: "Weak",
      strengths: [],
      weaknesses: [
        "code-generation",
        "code-review",
        "debugging",
        "reasoning",
        "math",
        "analysis",
      ],
      contextWindow: 4_096,
      costTier: "free",
      speedTier: "instant",
      provider: "test",
    };
    const score = scoreModelForTask(weakProfile, [
      "code-generation",
      "code-review",
      "debugging",
      "reasoning",
      "math",
      "analysis",
    ]);
    // 6 * -0.2 = -1.2 -> clamped to -1
    expect(score).toBe(-1);
  });
});
