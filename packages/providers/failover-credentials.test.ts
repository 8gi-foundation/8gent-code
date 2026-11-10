/**
 * Failover skips providers with no credentials (Termux report, 7 Nov): MiniMax
 * timed out, failover went to OpenRouter which had no key, and the turn errored.
 */
import { describe, expect, test } from "bun:test";
import {
	type FailoverChain,
	type FailoverChannel,
	ModelFailover,
	NoCredentialedProviderError,
} from "./failover";

const chains: Record<FailoverChannel, Record<string, FailoverChain>> = {
	text: {
		"MiniMax-M2.7": {
			models: [
				{ model: "MiniMax-M2.7", provider: "minimax" },
				{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
				{ model: "qwen3:14b", provider: "ollama" },
			],
		},
		"only-hosted": {
			models: [
				{ model: "only-hosted", provider: "minimax" },
				{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
			],
		},
	},
	computer: {},
};

const opts = (keys: string[]) => ({
	allowHosted: true,
	allow: null,
	policy: () => "cloud-first" as const,
	hasCredentials: (p: string) => p === "ollama" || keys.includes(p),
});

describe("failover credentials", () => {
	test("skips a keyless provider and lands on the next usable one", () => {
		const fo = new ModelFailover(chains, opts(["minimax"]));
		fo.markDown("MiniMax-M2.7", "minimax");
		expect(fo.resolve("MiniMax-M2.7").provider).toBe("ollama");
	});

	test("uses a hosted provider once it has a key", () => {
		const fo = new ModelFailover(chains, opts(["minimax", "openrouter"]));
		fo.markDown("MiniMax-M2.7", "minimax");
		expect(fo.resolve("MiniMax-M2.7").provider).toBe("openrouter");
	});

	test("never defaults to keyless openrouter for a model with no chain", () => {
		const fo = new ModelFailover(chains, opts([]));
		expect(() => fo.resolve("unknown-model")).toThrow(NoCredentialedProviderError);
	});

	test("throws naming the skipped providers when none has a key", () => {
		const fo = new ModelFailover(chains, opts([]));
		expect(() => fo.resolve("only-hosted")).toThrow(/no API key: minimax, openrouter/);
	});

	test("nextHop skips keyless providers", () => {
		const fo = new ModelFailover(chains, opts(["minimax"]));
		expect(fo.nextHop("MiniMax-M2.7", "minimax")?.provider).toBe("ollama");
	});

	test("skippedForCredentials names what was passed over", () => {
		const fo = new ModelFailover(chains, opts(["minimax"]));
		expect(fo.skippedForCredentials("MiniMax-M2.7")).toEqual(["openrouter"]);
	});

	test("no check set: behaviour unchanged", () => {
		const fo = new ModelFailover(chains, {
			allowHosted: true,
			allow: null,
			policy: () => "cloud-first",
		});
		fo.markDown("MiniMax-M2.7", "minimax");
		expect(fo.resolve("MiniMax-M2.7").provider).toBe("openrouter");
	});
});
