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
import { getProviderManager } from "../../../../packages/providers/index.js";
import {
	type ModelSpec,
	declaredModels,
	normalizeProviderId,
	providerToRuntime,
	specForActivatedTab,
} from "./model-selection.js";

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

/**
 * Regression guard: launched with --provider/--model, the Orchestrator tab is
 * pinned to that spec. Switching Engineer -> QA -> back to Orchestrator used to
 * leave the foreground on QA's model, because the pinned-tab branch returned
 * without restoring anything. Returning to the pinned tab must restore it.
 */
describe("specForActivatedTab", () => {
	const pin = { tabId: "tab-orchestrator", spec: { provider: "ollama", model: "qwen3.8:27b-mlx" } };
	const small = { provider: "ollama", model: "llama3.2:3b" };

	test("re-entering the pinned tab restores the launch spec, not the previous tab's", () => {
		expect(specForActivatedTab("tab-orchestrator", pin, small)).toEqual(pin.spec);
	});

	test("other tabs get their role spec even while a pin exists", () => {
		expect(specForActivatedTab("tab-qa", pin, small)).toEqual(small);
	});

	test("without a CLI pin every tab gets its role spec", () => {
		expect(specForActivatedTab("tab-orchestrator", null, small)).toEqual(small);
	});

	test("no role spec and no pin leaves the current model alone", () => {
		expect(specForActivatedTab("tab-engineer", null, null)).toBeNull();
	});

	test("a full Orchestrator -> Engineer -> QA -> Orchestrator walk ends on the launch model", () => {
		const roles: Record<string, ModelSpec> = {
			"tab-orchestrator": { provider: "ollama", model: "role-default:8b" },
			"tab-engineer": small,
			"tab-qa": small,
		};
		let current: ModelSpec = pin.spec;
		for (const tab of ["tab-engineer", "tab-qa", "tab-orchestrator"]) {
			current = specForActivatedTab(tab, pin, roles[tab] ?? null) ?? current;
		}
		expect(current.model).toBe("qwen3.8:27b-mlx");
	});
});

describe("declaredModels: the registry, never a placeholder id", () => {
	test("8gent lists the models its registry entry declares", () => {
		const pm = getProviderManager();
		const models = declaredModels(pm, "8gent");
		expect(models).toEqual([...pm.getProvider("8gent").models]);
		expect(models).toContain(pm.getProvider("8gent").defaultModel);
	});

	test("no provider in the registry yields an invented '<provider>/default'", () => {
		const pm = getProviderManager();
		for (const p of pm.listProviders()) {
			expect(declaredModels(pm, String(p.name))).not.toContain(`${p.name}/default`);
		}
	});

	test("a name the registry does not know yields no models", () => {
		expect(declaredModels(getProviderManager(), "not-a-provider")).toEqual([]);
		expect(declaredModels(getProviderManager(), "")).toEqual([]);
	});
});
