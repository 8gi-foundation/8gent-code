import { describe, expect, test } from "bun:test";
import {
	type FailoverChain,
	type FailoverChannel,
	ModelFailover,
	NoServableProviderError,
} from "./failover";

const empty: Record<FailoverChannel, Record<string, FailoverChain>> = { text: {}, computer: {} };
const opts = (keyed: string[]) => ({
	allowHosted: true,
	policy: () => "cloud-first" as const,
	canServe: (p: string) => keyed.includes(p) || ["llama-server", "ollama"].includes(p),
});
const llama = { model: "qwen-local", provider: "llama-server" };

describe("a keyless hop is not a fallback", () => {
	test("unchained hosted model, no openrouter key: never openrouter after markDown", () => {
		const fo = new ModelFailover(empty, opts([]));
		fo.markDown("MiniMax-M2", "minimax");
		expect(() => fo.resolve("MiniMax-M2")).toThrow(NoServableProviderError);
	});

	test("same, with llama-server up: the local runtime takes the turn", () => {
		const fo = new ModelFailover(empty, opts([]));
		fo.setLocalServing([llama]);
		fo.markDown("MiniMax-M2", "minimax");
		expect(fo.resolve("MiniMax-M2")).toEqual(llama);
		expect(fo.nextHop("MiniMax-M2", "minimax")).toEqual(llama);
	});

	test("unchained with an openrouter key: unchanged, openrouter first", () => {
		const fo = new ModelFailover(empty, opts(["openrouter"]));
		fo.setLocalServing([llama]);
		expect(fo.resolve("MiniMax-M2")).toEqual({ model: "MiniMax-M2", provider: "openrouter" });
		fo.markDown("MiniMax-M2", "openrouter");
		expect(fo.resolve("MiniMax-M2")).toEqual(llama);
	});

	test("chained hosted model: keyless entries skipped, local tail added", () => {
		const chains = {
			text: {
				m: {
					models: [
						{ model: "m", provider: "minimax" },
						{ model: "x", provider: "openrouter" },
					],
				},
			},
			computer: {},
		};
		const fo = new ModelFailover(chains, opts([]));
		fo.setLocalServing([llama]);
		fo.markDown("m", "minimax");
		expect(fo.resolve("m")).toEqual(llama);
	});

	test("existing chain with keys present keeps its order", () => {
		const chains = {
			text: {
				m: {
					models: [
						{ model: "m", provider: "minimax" },
						{ model: "x", provider: "openrouter" },
						{ model: "e", provider: "ollama" },
					],
				},
			},
			computer: {},
		};
		const fo = new ModelFailover(chains, opts(["minimax", "openrouter"]));
		fo.setLocalServing([llama]);
		fo.markDown("m", "minimax");
		expect(fo.resolve("m")).toEqual({ model: "x", provider: "openrouter" });
		fo.markDown("x", "openrouter");
		expect(fo.resolve("m")).toEqual({ model: "e", provider: "ollama" });
	});

	test("all-local chain gets no tail", () => {
		const chains = { text: { e: { models: [{ model: "e", provider: "ollama" }] } }, computer: {} };
		const fo = new ModelFailover(chains, opts([]));
		fo.setLocalServing([llama]);
		fo.markDown("e", "ollama");
		expect(fo.nextHop("e", "ollama")).toBeNull();
	});
});

describe("the plain line when nothing can take over", () => {
	test("names the stall, no local model, and a local next step first", async () => {
		const { noServableHopLine } = await import("../eight/agent");
		const line = noServableHopLine("MiniMax-M2", "No reply from minimax after 300s; stopped");
		expect(line).toBe(
			"MiniMax-M2 gave no reply in 300 s. No local model is running and no other provider is ready. Start one with /llama, or choose another with /provider.",
		);
		expect(line).not.toMatch(/openrouter|key/i);
	});
});
