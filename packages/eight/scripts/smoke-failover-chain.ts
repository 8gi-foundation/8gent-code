#!/usr/bin/env bun
/**
 * Smoke test: channel-aware failover chain.
 *
 * Simulates the computer-channel chain: apfel → Qwen 3.6-27B →
 * DeepSeek V4-Flash → OpenRouter `:free`. Marks each upstream tier "down"
 * one at a time and confirms the next tier is selected. Verifies events
 * are recorded and that the text channel is unaffected.
 *
 * No live model calls. Pure resolver logic + event log. Always exits 0
 * unless the resolver behaves wrong.
 */

import { ModelFailover } from "../../providers/failover";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		console.error(`[smoke-failover] ASSERT FAIL: ${message}`);
		process.exit(1);
	}
}

const fo = new ModelFailover();

// ---- text channel (back-compat) ------------------------------------------
const text = fo.resolve("eight:latest", "text");
assert(text.model && text.provider, "text channel must resolve to something");
console.log(`[smoke-failover] text channel default: ${text.provider}/${text.model}`);

// ---- computer channel ----------------------------------------------------
const tier1 = fo.resolve("qwen3.6:27b", "computer");
console.log(`[smoke-failover] computer tier 1: ${tier1.provider}/${tier1.model}`);
assert(
	tier1.provider === "apfel" || tier1.provider === "ollama",
	"computer tier 1 should be apfel or ollama",
);

// Mark apfel down → expect Qwen.
fo.markDown("apple-foundationmodel", "apfel");
const tier2 = fo.resolve("qwen3.6:27b", "computer");
console.log(`[smoke-failover] computer tier 2: ${tier2.provider}/${tier2.model}`);
assert(tier2.provider === "ollama" && tier2.model === "qwen3.6:27b", "tier 2 should be Qwen");

// Mark Qwen down → expect DeepSeek.
fo.markDown("qwen3.6:27b", "ollama");
const tier3 = fo.resolve("qwen3.6:27b", "computer");
console.log(`[smoke-failover] computer tier 3: ${tier3.provider}/${tier3.model}`);
assert(tier3.provider === "deepseek", "tier 3 should be DeepSeek");

// Mark DeepSeek down → expect OpenRouter free.
fo.markDown("deepseek-v4-flash", "deepseek");
const tier4 = fo.resolve("qwen3.6:27b", "computer");
console.log(`[smoke-failover] computer tier 4: ${tier4.provider}/${tier4.model}`);
assert(tier4.provider === "openrouter", "tier 4 should be OpenRouter free");

// Bring Qwen back → expect Qwen on next resolve.
fo.markUp("qwen3.6:27b", "ollama");
const tier2Restored = fo.resolve("qwen3.6:27b", "computer");
console.log(`[smoke-failover] computer restored: ${tier2Restored.provider}/${tier2Restored.model}`);
assert(
	tier2Restored.provider === "ollama" && tier2Restored.model === "qwen3.6:27b",
	"Qwen should resume primary",
);

// Verify failover events were logged.
const events = fo.drainEvents();
console.log(`[smoke-failover] events recorded: ${events.length}`);
assert(events.length >= 3, "expected at least 3 failover events");

console.log("[smoke-failover] OK");
process.exit(0);
