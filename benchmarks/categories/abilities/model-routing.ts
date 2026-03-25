// -- Model Routing Benchmark --------------------------------------------------
// Tests: packages/providers/ (ProviderManager, resolveModel, model-router)
// Validates that the task router picks appropriate models per task complexity,
// respects free-tier preference, and handles failover correctly.

import {
  ProviderManager,
  resolveModel,
  type ProviderName,
} from "../../../packages/providers/index";
import { getModelOrder, recordResult } from "../../autoresearch/model-router";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -- Helpers ------------------------------------------------------------------

function tmpSettingsPath(): string {
  const dir = join(tmpdir(), "8gent-model-routing-test");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "providers.json");
}

function cleanup(filepath: string): void {
  try { unlinkSync(filepath); } catch {}
}

type TestResult = { name: string; pass: boolean; detail: string };

// -- Test Cases ---------------------------------------------------------------

/**
 * T1 - Local model preferred for simple tasks.
 * A fresh ProviderManager (no saved settings) should default to a local
 * provider (8gent or ollama), not a cloud provider.
 */
function testLocalModelForSimpleTasks(): TestResult {
  const settingsPath = tmpSettingsPath();
  cleanup(settingsPath);

  const pm = new ProviderManager(settingsPath);
  const active = pm.getActiveProvider();
  const isLocal = active.name === "8gent" || active.name === "ollama";

  cleanup(settingsPath);
  return {
    name: "Local model selected for simple tasks",
    pass: isLocal,
    detail: `Active provider: ${active.name} (${active.displayName}), model: ${pm.getActiveModel()}`,
  };
}

/**
 * T2 - Cloud escalation for complex tasks.
 * When a cloud provider is enabled, it should be selectable. Simulates the
 * pattern: user enables openrouter -> sets it active -> provider is cloud.
 */
function testCloudEscalation(): TestResult {
  const settingsPath = tmpSettingsPath();
  cleanup(settingsPath);

  const pm = new ProviderManager(settingsPath);
  pm.enableProvider("openrouter");
  pm.setActiveProvider("openrouter");

  const active = pm.getActiveProvider();
  const isCloud = active.name === "openrouter";
  const hasCloudUrl = active.baseUrl.startsWith("https://");

  cleanup(settingsPath);
  return {
    name: "Cloud provider escalation works",
    pass: isCloud && hasCloudUrl,
    detail: `Provider: ${active.name}, URL: ${active.baseUrl}`,
  };
}

/**
 * T3 - Free-tier preference via resolveModel("auto:free").
 * The resolver should return an openrouter provider and a model string
 * (even if the API call fails, it should return a fallback).
 */
async function testFreeTierPreference(): Promise<TestResult> {
  const result = await resolveModel("auto:free");
  const isOpenRouter = result.provider === "openrouter";
  const hasModel = typeof result.model === "string" && result.model.length > 0;

  return {
    name: "Free-tier preference respected (auto:free)",
    pass: isOpenRouter && hasModel,
    detail: `Resolved to provider=${result.provider}, model=${result.model}`,
  };
}

/**
 * T4 - Non-free model passthrough.
 * resolveModel with a specific model string should return it unchanged.
 */
async function testNonFreePassthrough(): Promise<TestResult> {
  const result = await resolveModel("qwen3.5:latest");
  const unchanged = result.model === "qwen3.5:latest";
  const noProvider = result.provider === undefined;

  return {
    name: "Non-free model passes through unchanged",
    pass: unchanged && noProvider,
    detail: `model=${result.model}, provider=${result.provider ?? "none"}`,
  };
}

/**
 * T5 - Failover: when the active provider cannot serve (missing API key),
 * chat() should throw a clear error (the caller can then try the next provider).
 */
async function testFailoverOnMissingKey(): Promise<TestResult> {
  const settingsPath = tmpSettingsPath();
  cleanup(settingsPath);

  const pm = new ProviderManager(settingsPath);
  pm.enableProvider("openai"); // enabled but no API key
  pm.setActiveProvider("openai");

  let threw = false;
  let errorMsg = "";
  try {
    await pm.chat({ messages: [{ role: "user", content: "ping" }] });
  } catch (err: any) {
    threw = true;
    errorMsg = err.message ?? String(err);
  }

  cleanup(settingsPath);
  return {
    name: "Failover - clear error on missing API key",
    pass: threw && errorMsg.includes("No API key"),
    detail: threw ? `Error: ${errorMsg}` : "No error thrown - unexpected",
  };
}

/**
 * T6 - Experience-based router ranks models by past performance.
 * Record some scores, then verify getModelOrder returns the best first.
 */
function testExperienceBasedRouting(): TestResult {
  // Record synthetic results
  recordResult("model-a", "code-gen", "bench-001", 85);
  recordResult("model-a", "code-gen", "bench-001", 90);
  recordResult("model-b", "code-gen", "bench-001", 60);
  recordResult("model-c", "code-gen", "bench-001", 75);

  const order = getModelOrder(
    ["model-a", "model-b", "model-c"],
    "code-gen",
    "bench-001",
  );

  const bestFirst = order[0] === "model-a";
  const worstLast = order[order.length - 1] === "model-b";

  return {
    name: "Experience router ranks best model first",
    pass: bestFirst && worstLast,
    detail: `Order: ${order.join(" > ")}`,
  };
}

/**
 * T7 - Cold start exploration: untried models get exploration priority.
 * In a fresh domain with no history, a model with zero global runs should
 * rank above a model that has many runs elsewhere (lower exploration bonus).
 */
function testColdStartExploration(): TestResult {
  // Use a domain neither model has been tested on.
  // model-a has high runCounts from T6; model-fresh has zero runs anywhere.
  const order = getModelOrder(
    ["model-a", "model-fresh"],
    "unseen-domain",
    "bench-999",
  );

  // model-fresh (0 runs) gets higher exploration bonus than model-a (2+ runs)
  const freshFirst = order[0] === "model-fresh";

  return {
    name: "Cold start - untried model gets exploration priority",
    pass: freshFirst,
    detail: `Order: ${order.join(" > ")}`,
  };
}

// -- Benchmark Export ---------------------------------------------------------

export const benchmark = {
  id: "AB008",
  name: "Model Routing: Task-Aware Selection",
  ability: "model-routing",
  difficulty: "medium" as const,

  prompt: `Validate the model router logic:
1. Default provider is local (no cloud dependency out of the box).
2. Cloud providers activate when explicitly enabled.
3. "auto:free" resolves to an OpenRouter free model.
4. Specific model strings pass through unchanged.
5. Missing API keys produce clear errors (failover signal).
6. Experience-based router ranks best-performing models first.
7. Untried models get exploration priority on cold start.`,

  successCriteria: [
    "Default provider is local (8gent or ollama)",
    "Cloud escalation works when provider is enabled",
    "auto:free resolves to openrouter with a model string",
    "Non-free model strings pass through unchanged",
    "Missing API key throws descriptive error",
    "Experience router places highest-scoring model first",
    "Untried models rank above low-scoring tried models",
  ],

  scoring: [
    { metric: "local_default_correct", weight: 0.15 },
    { metric: "cloud_escalation_works", weight: 0.15 },
    { metric: "free_tier_resolved", weight: 0.15 },
    { metric: "passthrough_correct", weight: 0.1 },
    { metric: "failover_error_clear", weight: 0.15 },
    { metric: "experience_ranking_correct", weight: 0.15 },
    { metric: "cold_start_exploration", weight: 0.15 },
  ],

  timeLimit: 30,
};

// -- Runner -------------------------------------------------------------------

export async function run(): Promise<{ score: number; results: TestResult[] }> {
  const results: TestResult[] = [];

  results.push(testLocalModelForSimpleTasks());
  results.push(testCloudEscalation());
  results.push(await testFreeTierPreference());
  results.push(await testNonFreePassthrough());
  results.push(await testFailoverOnMissingKey());
  results.push(testExperienceBasedRouting());
  results.push(testColdStartExploration());

  const passed = results.filter((r) => r.pass).length;
  const score = Math.round((passed / results.length) * 100);

  console.log(`\nModel Routing Benchmark: ${passed}/${results.length} passed (${score}/100)\n`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    console.log(`        ${r.detail}`);
  }

  return { score, results };
}

export default benchmark;
