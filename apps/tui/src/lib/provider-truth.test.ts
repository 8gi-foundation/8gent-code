/**
 * #4598: the provider picker, the model beside a provider, and the reason a
 * provider cannot start must all be true. Pure helpers, no TUI mount.
 */

import { describe, expect, test } from "bun:test";
import {
	buildProviderOptions,
	listBelongsToProvider,
	listModelsWithReason,
	modelAfterProviderSwitch,
	modelListFailureNotice,
	providerKeyNotice,
	registryKeyNotice,
} from "./provider-truth";

const cfg = (name: string, o: Record<string, unknown> = {}) => ({
	name,
	displayName: name.toUpperCase(),
	apiKeyEnv: "",
	enabled: true,
	...o,
});

const registry = (keys: Record<string, string> = {}) => ({
	listProviders: () => [
		cfg("ollama"),
		cfg("openrouter", { displayName: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY" }),
		cfg("minimax", { displayName: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY", enabled: false }),
	],
	getApiKey: (n: string) => keys[n] ?? null,
});

describe("buildProviderOptions (picker comes from the registry)", () => {
	test("every registered provider appears, MiniMax included", () => {
		const names = buildProviderOptions(registry()).map((o) => o.name);
		expect(names).toContain("minimax");
		expect(names).toContain("ollama");
		expect(names).toContain("openrouter");
	});

	test("uses the registry display name, not a literal", () => {
		const mm = buildProviderOptions(registry()).find((o) => o.name === "minimax");
		expect(mm?.displayName).toBe("MiniMax");
	});

	test("key configured only when the key is present", () => {
		const without = buildProviderOptions(registry());
		expect(without.find((o) => o.name === "minimax")?.hasApiKey).toBe(false);
		const withKey = buildProviderOptions(registry({ minimax: "k" }));
		expect(withKey.find((o) => o.name === "minimax")?.hasApiKey).toBe(true);
	});

	test("a keyless local provider never claims a key and is marked as needing none", () => {
		const o = buildProviderOptions(registry()).find((x) => x.name === "ollama");
		expect(o?.hasApiKey).toBe(false);
		expect(o?.needsKey).toBe(false);
	});

	test("a disabled provider with a key is selectable; without a key it is not", () => {
		expect(
			buildProviderOptions(registry({ minimax: "k" })).find((o) => o.name === "minimax")?.enabled,
		).toBe(true);
		expect(buildProviderOptions(registry()).find((o) => o.name === "minimax")?.enabled).toBe(false);
	});

	test("openrouter-free alias follows openrouter and shares its key", () => {
		const opts = buildProviderOptions(registry({ openrouter: "k" }));
		const i = opts.findIndex((o) => o.name === "openrouter");
		expect(opts[i + 1]?.name).toBe("openrouter-free");
		expect(opts[i + 1]?.hasApiKey).toBe(true);
	});

	test("a throwing registry yields an empty list, not a crash", () => {
		const bad = {
			listProviders: () => {
				throw new Error("x");
			},
			getApiKey: () => null,
		};
		expect(buildProviderOptions(bad)).toEqual([]);
	});
});

describe("a model is only shown with the provider that owns it", () => {
	test("a list fetched for apfel is not minimax's", () => {
		expect(listBelongsToProvider("apfel", "minimax")).toBe(false);
		expect(listBelongsToProvider("minimax", "minimax")).toBe(true);
	});

	test("switching provider drops the previous provider's model", () => {
		expect(modelAfterProviderSwitch("ollama", "minimax", "qwen3:14b")).toBe("");
	});

	test("re-selecting the same provider keeps its model", () => {
		expect(modelAfterProviderSwitch("minimax", "minimax", "m1")).toBe("m1");
	});
});

describe("providerKeyNotice (missing key says which key)", () => {
	test("names the env var and 8gent keys", () => {
		expect(providerKeyNotice({ displayName: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY" }, false)).toBe(
			"MiniMax needs MINIMAX_API_KEY. Add it with `8gent keys`.",
		);
	});
	test("null when the key is present or none is needed", () => {
		expect(
			providerKeyNotice({ displayName: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY" }, true),
		).toBeNull();
		expect(providerKeyNotice({ displayName: "Ollama", apiKeyEnv: "" }, false)).toBeNull();
	});
});

describe("modelListFailureNotice (a failed fetch says the status)", () => {
	test("HTTP status from the discovery error", () => {
		const n = modelListFailureNotice(
			"MiniMax",
			new Error("Model discovery failed for https://x/v1/models: 401 bad key"),
		);
		expect(n).toContain("MiniMax");
		expect(n).toContain("HTTP 401");
	});
	test("timeout and network errors are named, not blamed on a key", () => {
		expect(
			modelListFailureNotice("MiniMax", new Error("Model discovery timed out after 5000ms for u")),
		).toContain("timed out");
		expect(modelListFailureNotice("MiniMax", new TypeError("fetch failed"))).toContain(
			"fetch failed",
		);
	});
	test("no error recorded: still a true, generic line", () => {
		expect(modelListFailureNotice("MiniMax", undefined)).toContain("returned no models");
	});
});

describe("listModelsWithReason", () => {
	const reader = (over: Record<string, unknown>) => ({
		isKnownProvider: () => true,
		getProvider: () => ({ models: [] as string[] }),
		discoverModels: async () => [] as string[],
		...over,
	});
	test("live list wins", async () => {
		const r = await listModelsWithReason(
			reader({ discoverModels: async () => ["a", " b "] }) as never,
			"p",
		);
		expect(r).toEqual({ models: ["a", "b"] });
	});
	test("a failed fetch returns the error and the recorded list", async () => {
		const err = new Error("Model discovery failed for u: 503 down");
		const r = await listModelsWithReason(
			reader({
				discoverModels: async () => {
					throw err;
				},
				getProvider: () => ({ models: ["saved"] }),
			}) as never,
			"p",
		);
		expect(r.models).toEqual(["saved"]);
		expect(r.error).toBe(err);
	});
});

describe("registryKeyNotice", () => {
	const reader = (keys: Record<string, string>) => ({
		isKnownProvider: (n: string) => n !== "nope",
		getProvider: (n: string) =>
			n === "minimax"
				? { displayName: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY" }
				: { displayName: n, apiKeyEnv: "" },
		getApiKey: (n: string) => keys[n] ?? null,
	});
	test("minimax with no key", () => {
		expect(registryKeyNotice("minimax", reader({}))).toBe(
			"MiniMax needs MINIMAX_API_KEY. Add it with `8gent keys`.",
		);
	});
	test("minimax with a key, a local provider and an unknown name are all null", () => {
		expect(registryKeyNotice("minimax", reader({ minimax: "k" }))).toBeNull();
		expect(registryKeyNotice("ollama", reader({}))).toBeNull();
		expect(registryKeyNotice("nope", reader({}))).toBeNull();
	});
	test("openrouter keeps its own notice", () => {
		expect(registryKeyNotice("openrouter", reader({}))).toBeNull();
	});
});
