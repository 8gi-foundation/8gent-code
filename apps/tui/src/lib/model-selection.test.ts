/**
 * Contract tests for `providerToRuntime` - the single authority that maps a
 * TUI provider id to the Agent runtime literal.
 *
 * Regression guard: launching with `--provider=lmstudio` once routed the turn
 * to ollama because the turn-serving agent's runtime defaulted to "ollama"
 * without honouring the active provider. The CLI flow now resolves runtime
 * exclusively through this function, so these assertions pin the behaviour the
 * TUI relies on. If any of them break, provider routing regresses.
 */

import { describe, expect, test } from "bun:test";
import { normalizeProviderId, providerToRuntime } from "./model-selection.js";

describe("providerToRuntime", () => {
	test("lmstudio maps to lmstudio (NOT ollama) - the reported bug", () => {
		expect(providerToRuntime("lmstudio")).toBe("lmstudio");
	});

	test("ollama maps to ollama", () => {
		expect(providerToRuntime("ollama")).toBe("ollama");
	});

	test("openrouter and openrouter-free map to openrouter", () => {
		expect(providerToRuntime("openrouter")).toBe("openrouter");
		expect(providerToRuntime("openrouter-free")).toBe("openrouter");
	});

	test("apfel (apple-foundation) falls through to ollama runtime", () => {
		expect(providerToRuntime("apfel")).toBe("ollama");
	});

	test("undefined falls back to the safe local default (ollama)", () => {
		expect(providerToRuntime(undefined)).toBe("ollama");
	});

	test("unknown providers fall back to ollama", () => {
		expect(providerToRuntime("some-unknown-provider")).toBe("ollama");
	});
});

describe("CLI provider flow: normalizeProviderId -> providerToRuntime", () => {
	// This mirrors what the TUI does for a CLI `--provider` flag: the raw CLI
	// string is normalized, then mapped to a runtime. The whole point of the fix
	// is that `--provider=lmstudio` ends at runtime "lmstudio", not "ollama".
	test("--provider=lmstudio yields runtime lmstudio", () => {
		const provider = normalizeProviderId("lmstudio");
		expect(provider).toBe("lmstudio");
		expect(providerToRuntime(provider)).toBe("lmstudio");
	});

	test("--provider=lm-studio (hyphenated alias) yields runtime lmstudio", () => {
		const provider = normalizeProviderId("lm-studio");
		expect(provider).toBe("lmstudio");
		expect(providerToRuntime(provider)).toBe("lmstudio");
	});

	test("--provider=ollama yields runtime ollama", () => {
		const provider = normalizeProviderId("ollama");
		expect(provider).toBe("ollama");
		expect(providerToRuntime(provider)).toBe("ollama");
	});

	test("--provider=openrouter-free yields runtime openrouter", () => {
		const provider = normalizeProviderId("openrouter-free");
		expect(provider).toBe("openrouter-free");
		expect(providerToRuntime(provider)).toBe("openrouter");
	});

	test("no --provider (undefined) yields the default ollama runtime", () => {
		const provider = normalizeProviderId(undefined);
		expect(provider).toBeUndefined();
		expect(providerToRuntime(provider)).toBe("ollama");
	});
});
