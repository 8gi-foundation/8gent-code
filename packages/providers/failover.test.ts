import { describe, expect, test } from "bun:test";
import { type FailoverChain, type FailoverChannel, ModelFailover } from "./failover";

const chains: Record<FailoverChannel, Record<string, FailoverChain>> = {
	text: {
		"ornith-1.0-9b": {
			models: [
				{ model: "ornith-1.0-9b", provider: "lmstudio" },
				{ model: "MiniMax-M2.7", provider: "apfel" },
				{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
			],
		},
		// A chain whose head is a preferred tier above the configured model,
		// as when Apple Foundation is prefixed on a qualifying Mac.
		"eight:latest": {
			models: [
				{ model: "apple-foundationmodel", provider: "apple-foundation" },
				{ model: "eight:latest", provider: "ollama" },
				{ model: "qwen3.5:latest", provider: "ollama" },
			],
		},
	},
	computer: {},
};

describe("ModelFailover.nextHop", () => {
	test("is the entry the agent moves to when the current model fails", () => {
		for (const [model, provider] of [
			["ornith-1.0-9b", "lmstudio"],
			["eight:latest", "ollama"],
		] as const) {
			const walk = new ModelFailover(chains);
			walk.markDown(model, provider);
			const expected = walk.resolve(model);
			expect(new ModelFailover(chains).nextHop(model, provider)).toEqual(expected);
		}
	});

	test("reads the real chain, not a fixed free tier", () => {
		const fo = new ModelFailover(chains);
		expect(fo.nextHop("ornith-1.0-9b", "lmstudio")).toEqual({
			model: "MiniMax-M2.7",
			provider: "apfel",
		});
		expect(fo.nextHop("eight:latest", "ollama")).toEqual({
			model: "apple-foundationmodel",
			provider: "apple-foundation",
		});
	});

	test("no chain for the model means no fallback", () => {
		expect(new ModelFailover(chains).nextHop("qwen3.8:27b-mlx", "ollama")).toBeNull();
	});

	test("skips entries already down and is null when none are left", () => {
		const fo = new ModelFailover(chains, { allowHosted: true });
		fo.markDown("MiniMax-M2.7", "apfel");
		expect(fo.nextHop("ornith-1.0-9b", "lmstudio")?.provider).toBe("openrouter");
		fo.markDown("meta-llama/llama-3-8b-instruct:free", "openrouter");
		expect(fo.nextHop("ornith-1.0-9b", "lmstudio")).toBeNull();
	});

	test("is read-only: no event recorded, nothing marked down", () => {
		const fo = new ModelFailover(chains);
		fo.nextHop("ornith-1.0-9b", "lmstudio");
		expect(fo.getEvents()).toEqual([]);
		expect(fo.isDown("ornith-1.0-9b", "lmstudio")).toBe(false);
	});
});

describe("apfel behind a hosted base URL (#3908)", () => {
	test("is dropped from chains without the hosted opt-in, kept on loopback", () => {
		const saved = process.env.APFEL_BASE_URL;
		try {
			process.env.APFEL_BASE_URL = "https://api.minimax.io/v1";
			const hosted = new ModelFailover(chains, { allowHosted: false });
			hosted.markDown("ornith-1.0-9b", "lmstudio");
			// apfel is gone, so with lmstudio down nothing hosted is reached.
			expect(hosted.resolve("ornith-1.0-9b").provider).toBe("lmstudio");

			process.env.APFEL_BASE_URL = "http://127.0.0.1:11500/v1";
			const local = new ModelFailover(chains, { allowHosted: false });
			local.markDown("ornith-1.0-9b", "lmstudio");
			expect(local.resolve("ornith-1.0-9b")).toEqual({ model: "MiniMax-M2.7", provider: "apfel" });
		} finally {
			if (saved === undefined) delete process.env.APFEL_BASE_URL;
			else process.env.APFEL_BASE_URL = saved;
		}
	});
});
