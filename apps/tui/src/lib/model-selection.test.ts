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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderManager, getProviderManager } from "../../../../packages/providers/index.js";
import {
	type ModelSpec,
	autoSelectModel,
	canReuseTabAgent,
	declaredModels,
	filterChatCapable,
	listsInstalledOllamaModels,
	missingModelNotice,
	normalizeProviderId,
	pickBestChatModel,
	providerToRuntime,
	specForActivatedTab,
	tabAgentRole,
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

// #3081: normalizeProviderId was a hand-kept list of eight names. Every other
// registry provider, starting with `8gent` (the out-of-box active provider),
// was silently dropped and the TUI fell back to the saved/default provider.
describe("normalizeProviderId validates against the provider registry (#3081)", () => {
	test("--provider 8gent is kept, not dropped", () => {
		expect(normalizeProviderId("8gent")).toBe("8gent");
	});

	test("every compiled registry provider survives normalisation", () => {
		for (const p of getProviderManager().listProviders()) {
			if (p.name === "lmstudio") continue; // alias-normalised, asserted below
			expect(normalizeProviderId(p.name)).toBe(p.name);
		}
	});

	test("underscores and case normalise to the registry id", () => {
		expect(normalizeProviderId("Host_CLI_Primary")).toBe("host-cli-primary");
		expect(normalizeProviderId("APFEL")).toBe("apfel");
		expect(normalizeProviderId("DeepSeek")).toBe("deepseek");
	});

	test("the TUI's own aliases still resolve", () => {
		expect(normalizeProviderId("lm_studio")).toBe("lmstudio");
		expect(normalizeProviderId("LM-Studio")).toBe("lmstudio");
		expect(normalizeProviderId("OpenRouter_Free")).toBe("openrouter-free");
	});

	test("a genuinely unknown provider is still rejected", () => {
		expect(normalizeProviderId("not-a-provider")).toBeUndefined();
		expect(normalizeProviderId("   ")).toBeUndefined();
	});

	test("a provider declared in providers.json is accepted, via the real registry", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "norm-provider-"));
		const file = path.join(dir, "providers.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ providers: { myrig: { baseUrl: "http://127.0.0.1:9999/v1", compat: "openai" } } }),
		);
		const pm = new ProviderManager(file);
		const isKnown = (n: string) => pm.isKnownProvider(n);
		expect(normalizeProviderId("myrig", isKnown)).toBe("myrig");
		expect(normalizeProviderId("8gent", isKnown)).toBe("8gent");
		expect(normalizeProviderId("nope", isKnown)).toBeUndefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// #3084: `--provider 8gent --model qwen3.8:27b-mlx`. The 8gent registry entry
// DECLARES eight-1.0-q3:14b; the validity check swapped the explicit model for
// it, that model was not installed, the agent rerouted to qwen3.8 and
// self-corrected config.model, and the TUI then dropped the "stale" agent as
// the turn finished, discarding the reply ("No reply.").
describe("an explicit --model is never overridden (#3084)", () => {
	const declared8gent = ["eight-1.0-q3:14b"];
	const pin: ModelSpec = { provider: "8gent", model: "qwen3.8:27b-mlx" };

	test("--provider 8gent --model X keeps X even though X is not in 8gent's declared list", () => {
		expect(
			autoSelectModel({ current: "qwen3.8:27b-mlx", currentProvider: "8gent", available: declared8gent, explicit: pin }),
		).toBeNull();
	});

	test("without an explicit choice, a model missing from the list is still auto-replaced", () => {
		expect(
			autoSelectModel({ current: "qwen3.8:27b-mlx", currentProvider: "8gent", available: declared8gent, explicit: null }),
		).toBe("eight-1.0-q3:14b");
	});

	test("the pin only protects its own provider: after switching provider the check runs", () => {
		expect(
			autoSelectModel({ current: "qwen3.8:27b-mlx", currentProvider: "lmstudio", available: ["m-a"], explicit: pin }),
		).toBe("m-a");
	});

	test("no model, an embedding model, or an empty list behave as before", () => {
		expect(autoSelectModel({ current: "", currentProvider: "ollama", available: ["llama3.2:3b"], explicit: null })).toBe(
			"llama3.2:3b",
		);
		expect(
			autoSelectModel({
				current: "nomic-embed-text:latest",
				currentProvider: "ollama",
				available: ["nomic-embed-text:latest", "llama3.2:3b"],
				explicit: null,
			}),
		).toBe("llama3.2:3b");
		expect(autoSelectModel({ current: "x", currentProvider: "ollama", available: [], explicit: null })).toBeNull();
		expect(
			autoSelectModel({ current: "llama3.2:3b", currentProvider: "ollama", available: ["llama3.2:3b"], explicit: null }),
		).toBeNull();
	});

	test("a rerouted agent (live config.model changed) is still reused for the spec it was built for", () => {
		const built = { model: "eight-1.0-q3:14b", runtime: "ollama" };
		// The live config would now say qwen3.8 after the reroute; reuse keys on the build spec.
		expect(canReuseTabAgent(built, { model: "eight-1.0-q3:14b", runtime: "ollama" })).toBe(true);
		expect(canReuseTabAgent(built, { model: "eight-1.0-q3:14b", runtime: "lmstudio" })).toBe(false);
		expect(canReuseTabAgent(built, { model: "qwen3.8:27b-mlx", runtime: "ollama" })).toBe(false);
	});
});

describe("tabAgentRole (#3095)", () => {
	test("reads the role a workspace chat tab carries", () => {
		expect(tabAgentRole({ role: "orchestrator", systemPrompt: "x" })).toBe("orchestrator");
		expect(tabAgentRole({ role: "engineer" })).toBe("engineer");
		expect(tabAgentRole({ role: "qa" })).toBe("qa");
	});
	test("anything else is no role", () => {
		expect(tabAgentRole(undefined)).toBeUndefined();
		expect(tabAgentRole({})).toBeUndefined();
		expect(tabAgentRole({ role: "admin" })).toBeUndefined();
	});
});

// #3332: the 8gent provider IS the configured Ollama (localhost:11434), but the
// TUI read its model list from the registry's declared list. That list holds
// eight-1.0-q3:14b, which is not installed, so the missing default stayed the
// session model and every turn asked Ollama for it, missed, and fell through to
// OpenRouter with an id OpenRouter does not serve ("All providers exhausted").
describe("a missing default model is swapped before the first turn (#3332)", () => {
	const installed = ["qwen3.5:9b-32k", "qwen3.5:9b", "qwen3.8:27b-mlx", "nomic-embed-text:latest"];

	test("8gent and ollama list what Ollama has installed; other providers do not", () => {
		expect(listsInstalledOllamaModels("8gent")).toBe(true);
		expect(listsInstalledOllamaModels("ollama")).toBe(true);
		expect(listsInstalledOllamaModels("lmstudio")).toBe(false);
		expect(listsInstalledOllamaModels("openrouter")).toBe(false);
		expect(listsInstalledOllamaModels("")).toBe(false);
	});

	test("default absent: the installed list replaces it with an installed chat model", () => {
		const next = autoSelectModel({ current: "eight-1.0-q3:14b", currentProvider: "8gent", available: installed, explicit: null });
		expect(next).not.toBeNull();
		expect(installed).toContain(next as string);
		expect(next).not.toBe("nomic-embed-text:latest");
	});

	test("default present: it is kept and no notice is shown", () => {
		const withDefault = [...installed, "eight-1.0-q3:14b"];
		expect(
			autoSelectModel({ current: "eight-1.0-q3:14b", currentProvider: "8gent", available: withDefault, explicit: null }),
		).toBeNull();
		expect(missingModelNotice({ provider: "8gent", from: "eight-1.0-q3:14b", to: "qwen3.5:9b", available: withDefault })).toBeNull();
	});

	test("an explicit --model still wins over the installed list (#3084 holds)", () => {
		const pin: ModelSpec = { provider: "8gent", model: "eight-1.0-q3:14b" };
		expect(
			autoSelectModel({ current: "eight-1.0-q3:14b", currentProvider: "8gent", available: installed, explicit: pin }),
		).toBeNull();
	});

	test("the swap of a missing model says so in one line, naming both models", () => {
		const notice = missingModelNotice({ provider: "8gent", from: "eight-1.0-q3:14b", to: "qwen3.8:27b-mlx", available: installed });
		expect(notice).toBe("eight-1.0-q3:14b is not installed in Ollama, so this session uses qwen3.8:27b-mlx. Pick another with /model.");
		expect(notice).not.toContain("\n");
	});

	test("a model that is installed but cannot chat is not called missing (#3548)", () => {
		const notice = missingModelNotice({
			provider: "ollama",
			from: "clef:27b",
			to: "qwen3.5:14b",
			available: ["qwen3.5:14b"],
			installed: ["clef:27b", "qwen3.5:14b"],
		});
		expect(notice).toBe("clef:27b cannot be used for chat, so this session uses qwen3.5:14b. Pick another with /model.");
		expect(notice).not.toContain("not installed");
	});

	test("a model absent from the installed list is still called missing", () => {
		expect(
			missingModelNotice({
				provider: "8gent",
				from: "eight-1.0-q3:14b",
				to: "qwen3.5:14b",
				available: ["qwen3.5:14b"],
				installed: ["clef:27b", "qwen3.5:14b"],
			}),
		).toBe("eight-1.0-q3:14b is not installed in Ollama, so this session uses qwen3.5:14b. Pick another with /model.");
	});

	test("no notice for a first pick, a non-Ollama provider, or a model that is installed", () => {
		expect(missingModelNotice({ provider: "8gent", from: "", to: "qwen3.5:9b", available: installed })).toBeNull();
		expect(missingModelNotice({ provider: "lmstudio", from: "x", to: "m-a", available: ["m-a"] })).toBeNull();
		expect(missingModelNotice({ provider: "ollama", from: "qwen3.5:9b", to: "qwen3.8:27b-mlx", available: installed })).toBeNull();
	});
});

describe("filterChatCapable (#3548)", () => {
	const ROOT = "http://ollama.test:11434";
	/** A stub /api/show: capabilities per model, or a status / throw. */
	function stubShow(table: Record<string, string[] | number | "throw" | "none">) {
		const calls: string[] = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			const model = JSON.parse(String(init?.body ?? "{}")).model as string;
			calls.push(`${url} ${model}`);
			const entry = table[model];
			if (entry === "throw") throw new Error("connection refused");
			if (typeof entry === "number") return new Response("", { status: entry });
			if (entry === "none" || entry === undefined) return Response.json({ modelfile: "FROM x" });
			return Response.json({ capabilities: entry });
		};
		return { calls, fetchImpl };
	}

	test("drops decision-only models that report no completion capability", async () => {
		const { fetchImpl } = stubShow({
			"clef:27b": ["decision"],
			"nimble:latest": ["decision"],
			"qwen3.5:14b": ["completion", "tools"],
		});
		const ids = ["clef:27b", "nimble:latest", "qwen3.5:14b"];
		const kept = await filterChatCapable(`${ROOT}/a`, ids, { fetch: fetchImpl });
		expect(kept).toEqual(["qwen3.5:14b"]);
		// The decision model no longer outranks the chat model in the picker.
		expect(pickBestChatModel(kept)).toBe("qwen3.5:14b");
	});

	test("keeps a model when capabilities are absent or the lookup fails, and name-filters it", async () => {
		const { fetchImpl } = stubShow({
			"old-chat:7b": "none",
			"broken:8b": 500,
			"down:3b": "throw",
			"nomic-embed-text:latest": "none",
		});
		const ids = ["old-chat:7b", "broken:8b", "down:3b", "nomic-embed-text:latest"];
		const kept = await filterChatCapable(`${ROOT}/b`, ids, { fetch: fetchImpl });
		expect(kept).toEqual(["old-chat:7b", "broken:8b", "down:3b"]);
	});

	test("reported capabilities win over the name heuristic", async () => {
		const { fetchImpl } = stubShow({
			"embed-chat-tuned:8b": ["completion"],
			"mxbai-embed-large:latest": ["embedding"],
		});
		const kept = await filterChatCapable(`${ROOT}/c`, ["embed-chat-tuned:8b", "mxbai-embed-large:latest"], {
			fetch: fetchImpl,
		});
		expect(kept).toEqual(["embed-chat-tuned:8b"]);
	});

	test("caches a known answer per host and model, but retries a failed lookup", async () => {
		const { calls, fetchImpl } = stubShow({ "qwen3.5:14b": ["completion"], "down:3b": "throw" });
		const root = `${ROOT}/d`;
		await filterChatCapable(root, ["qwen3.5:14b", "down:3b"], { fetch: fetchImpl });
		await filterChatCapable(root, ["qwen3.5:14b", "down:3b"], { fetch: fetchImpl });
		expect(calls.filter((c) => c.endsWith(" qwen3.5:14b"))).toEqual([`${root}/api/show qwen3.5:14b`]);
		expect(calls.filter((c) => c.endsWith(" down:3b")).length).toBe(2);
	});
});
