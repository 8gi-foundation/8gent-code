import { afterEach, describe, expect, test } from "bun:test";
import {
	type FailoverChain,
	type FailoverChannel,
	type FailoverEntry,
	ModelFailover,
	NoAllowedProviderError,
} from "./failover";

const LOCAL = ["8gent", "ollama", "lmstudio", "apple-foundation", "apfel"];
const CLOUD = new Set(["openrouter", "deepseek"]);

// Every chain key the default chains define, per channel.
const DEFAULT_KEYS: Record<FailoverChannel, string[]> = {
	text: [
		"openrouter/auto",
		"eight:latest",
		"qwen3.5:latest",
		"apple-foundationmodel",
		"google/gemma-4-26b-a4b",
	],
	computer: ["qwen3.6:27b", "apple-foundationmodel", "deepseek-flash"],
};

/**
 * The built-in chains, injected so the developer's own ~/.8gent/failover.json
 * can never change these results. A fresh copy per call: chains are not shared.
 */
const defaults = () => ModelFailover.defaultChains();

/** Every entry resolve() can ever hand back for a model, walking the chain to exhaustion. */
function walk(fo: ModelFailover, model: string, channel: FailoverChannel): FailoverEntry[] {
	const seen: FailoverEntry[] = [];
	for (let i = 0; i < 20; i++) {
		const entry = fo.resolve(model, channel);
		if (fo.isDown(entry.model, entry.provider)) break; // hail mary: already seen
		seen.push(entry);
		fo.markDown(entry.model, entry.provider);
	}
	return seen;
}

const prevAllow = process.env.EIGHT_PROVIDERS_ALLOW;
afterEach(() => {
	if (prevAllow === undefined) delete process.env.EIGHT_PROVIDERS_ALLOW;
	else process.env.EIGHT_PROVIDERS_ALLOW = prevAllow;
});

describe("EIGHT_PROVIDERS_ALLOW allowlist", () => {
	test("hosted opted in, no allowlist: still falls back to openrouter", () => {
		delete process.env.EIGHT_PROVIDERS_ALLOW;
		const fo = new ModelFailover(defaults(), { allowHosted: true });
		expect(fo.resolve("no-such-model")).toEqual({ model: "no-such-model", provider: "openrouter" });
		expect(
			walk(new ModelFailover(defaults(), { allowHosted: true }), "eight:latest", "text").some(
				(e) => e.provider === "openrouter",
			),
		).toBe(true);
	});

	for (const channel of ["text", "computer"] as const) {
		for (const model of DEFAULT_KEYS[channel]) {
			test(`${channel} chain ${model} never yields a cloud entry under a local allowlist`, () => {
				const fo = new ModelFailover(defaults(), { allow: LOCAL });
				let entries: FailoverEntry[] = [];
				try {
					entries = walk(fo, model, channel);
				} catch (err) {
					expect(err).toBeInstanceOf(NoAllowedProviderError);
				}
				for (const e of entries) {
					expect(CLOUD.has(e.provider)).toBe(false);
					expect(LOCAL).toContain(e.provider);
				}
			});
		}
	}

	test("a chain filtered to nothing throws a typed error instead of returning openrouter", () => {
		const fo = new ModelFailover(defaults(), { allow: LOCAL });
		expect(() => fo.resolve("openrouter/auto")).toThrow(NoAllowedProviderError);
		try {
			fo.resolve("openrouter/auto");
		} catch (err) {
			const e = err as NoAllowedProviderError;
			expect(e.model).toBe("openrouter/auto");
			expect(e.channel).toBe("text");
			expect(e.allowed).toEqual(LOCAL);
		}
	});

	test("an unknown model throws when openrouter is not allowed", () => {
		const fo = new ModelFailover(defaults(), { allow: ["ollama"] });
		expect(() => fo.resolve("no-such-model")).toThrow(NoAllowedProviderError);
	});

	test("an unknown model still goes to openrouter when openrouter is allowed and hosted opted in", () => {
		const fo = new ModelFailover(defaults(), {
			allow: ["ollama", "openrouter"],
			allowHosted: true,
		});
		expect(fo.resolve("no-such-model")).toEqual({ model: "no-such-model", provider: "openrouter" });
	});

	test("filters injected chains and nextHop too", () => {
		const chains: Record<FailoverChannel, Record<string, FailoverChain>> = {
			text: {
				m: {
					models: [
						{ model: "m", provider: "ollama" },
						{ model: "x:free", provider: "openrouter" },
					],
				},
			},
			computer: {},
		};
		const fo = new ModelFailover(chains, { allow: ["ollama"] });
		expect(fo.nextHop("m", "ollama")).toBeNull();
		fo.markDown("m", "ollama");
		// Every allowed entry is down: hail mary stays inside the allowlist.
		expect(fo.resolve("m")).toEqual({ model: "m", provider: "ollama" });
		// The caller's chain object is not mutated.
		expect(chains.text.m.models).toHaveLength(2);
	});

	test("reads EIGHT_PROVIDERS_ALLOW from the environment, trimmed and case-insensitive", () => {
		process.env.EIGHT_PROVIDERS_ALLOW = " Ollama , 8gent ,";
		const fo = new ModelFailover(defaults());
		expect(() => fo.resolve("openrouter/auto")).toThrow(NoAllowedProviderError);
		for (const e of walk(fo, "qwen3.5:latest", "text")) {
			expect(["ollama", "8gent"]).toContain(e.provider);
		}
	});

	test("malformed chains and entries are dropped, failing closed instead of crashing", () => {
		const chains = {
			text: {
				noModels: {},
				nullChain: null,
				badEntries: { models: [{ model: "x" }, null, { model: "y", provider: 7 }] },
				mixed: {
					models: [
						{ model: "z" },
						{ model: "mixed", provider: "ollama" },
						{ model: "c:free", provider: "openrouter" },
					],
				},
			},
			computer: null,
		} as unknown as Record<FailoverChannel, Record<string, FailoverChain>>;
		const fo = new ModelFailover(chains, { allow: ["ollama"] });
		for (const model of ["noModels", "nullChain", "badEntries"]) {
			expect(() => fo.resolve(model)).toThrow(NoAllowedProviderError);
		}
		expect(fo.resolve("mixed")).toEqual({ model: "mixed", provider: "ollama" });
		expect(() => fo.resolve("anything", "computer")).toThrow(NoAllowedProviderError);
	});

	test("an injected allow list is trimmed and lowercased like the env value", () => {
		const fo = new ModelFailover(defaults(), { allow: [" Ollama ", "8GENT"] });
		for (const e of walk(fo, "qwen3.5:latest", "text")) {
			expect(["ollama", "8gent"]).toContain(e.provider);
		}
		expect(() => fo.resolve("openrouter/auto")).toThrow(NoAllowedProviderError);
	});

	test("an empty injected allow list allows nothing", () => {
		const fo = new ModelFailover(defaults(), { allow: [] });
		expect(() => fo.resolve("qwen3.5:latest")).toThrow(NoAllowedProviderError);
	});

	test("an empty or whitespace-only value means no allowlist", () => {
		process.env.EIGHT_PROVIDERS_ALLOW = " , ";
		expect(
			new ModelFailover(defaults(), { allowHosted: true }).resolve("no-such-model").provider,
		).toBe("openrouter");
	});
});
