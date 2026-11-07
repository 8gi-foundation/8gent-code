/**
 * The hop after a failed provider (phone, 7 Nov 2026).
 *
 * James's phone: "how does my day look today?" went to minimax, minimax failed, and the
 * turn ended with "all providers failed (1 tried)". Chains are keyed by model id and a
 * hosted registry model (minimax's) has none, so resolve() had no next entry (hosted off:
 * it threw NoAllowedProviderError, which the 8gent loop read as "chain exhausted"). Under a
 * local-first policy the local providers must be tried before the turn gives up.
 */

import { describe, expect, test } from "bun:test";
import { type FailoverEntry, ModelFailover, isHostedProvider } from "./failover";

const MINIMAX: FailoverEntry = { provider: "minimax", model: "MiniMax-M2" };

/** Every hop the 8gent loop would take from `start`, marking each one down as it fails. */
function walk(fo: ModelFailover, start: FailoverEntry): FailoverEntry[] {
	const hops: FailoverEntry[] = [];
	let cur = start;
	fo.markDown(cur.model, cur.provider);
	for (let i = 0; i < 30; i++) {
		const next = fo.nextAfter(cur, "text");
		if (!next) break;
		hops.push(next);
		fo.markDown(next.model, next.provider);
		cur = next;
	}
	return hops;
}

const fresh = (allowHosted: boolean, policy: "local-first" | "local-only" | "cloud-first") =>
	new ModelFailover(ModelFailover.defaultChains(), {
		allowHosted,
		policy: () => policy,
		allow: null,
	});

describe("nextAfter: a model with no chain of its own", () => {
	test("hosted off, local-first: a failed minimax turn moves to a local provider, not the end", () => {
		const fo = fresh(false, "local-first");
		fo.markDown(MINIMAX.model, MINIMAX.provider);
		const next = fo.nextAfter(MINIMAX, "text");
		expect(next).not.toBeNull();
		expect(isHostedProvider(next!.provider)).toBe(false);
	});

	test("hosted off: the walk visits local providers only, each once, then ends", () => {
		const hops = walk(fresh(false, "local-first"), MINIMAX);
		expect(hops.length).toBeGreaterThan(1);
		expect(hops.every((h) => !isHostedProvider(h.provider))).toBe(true);
		const keys = hops.map((h) => `${h.provider}::${h.model}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("hosted on, local-first: local providers come before the hosted hop", () => {
		const hops = walk(fresh(true, "local-first"), MINIMAX);
		const firstHosted = hops.findIndex((h) => isHostedProvider(h.provider));
		const lastLocal = hops.map((h) => isHostedProvider(h.provider)).lastIndexOf(false);
		expect(hops.length).toBeGreaterThan(1);
		expect(isHostedProvider(hops[0].provider)).toBe(false);
		if (firstHosted !== -1) expect(firstHosted).toBeGreaterThan(0);
		expect(lastLocal).toBeGreaterThanOrEqual(0);
	});

	test("local-only never hands back a hosted entry", () => {
		const hops = walk(fresh(true, "local-only"), MINIMAX);
		expect(hops.length).toBeGreaterThan(0);
		expect(hops.some((h) => isHostedProvider(h.provider))).toBe(false);
	});

	test("cloud-first keeps the chain's own hosted hop first", () => {
		const fo = fresh(true, "cloud-first");
		fo.markDown(MINIMAX.model, MINIMAX.provider);
		expect(fo.nextAfter(MINIMAX, "text")).toEqual({ model: "MiniMax-M2", provider: "openrouter" });
	});

	test("an allowlist with no local provider still ends the chain (null), never a hosted escape", () => {
		const fo = new ModelFailover(ModelFailover.defaultChains(), {
			allow: ["minimax"],
			allowHosted: true,
			policy: () => "local-first",
		});
		fo.markDown(MINIMAX.model, MINIMAX.provider);
		expect(fo.nextAfter(MINIMAX, "text")).toBeNull();
	});
});

describe("nextAfter: a model with a chain behaves as resolve() did", () => {
	test("the next healthy entry of the model's own chain", () => {
		const fo = fresh(false, "local-first");
		fo.markDown("eight:latest", "ollama");
		expect(fo.nextAfter({ model: "eight:latest", provider: "ollama" }, "text")).toEqual({
			model: "qwen3.5:latest",
			provider: "ollama",
		});
	});

	test("its own hosted hop is not jumped by a local model from another chain", () => {
		const fo = fresh(true, "local-first");
		fo.markDown("eight:latest", "ollama");
		fo.markDown("qwen3.5:latest", "ollama");
		// A Mac with the Apple Foundation bridge puts it at every chain's head.
		fo.markDown("apple-foundationmodel", "apple-foundation");
		const next = fo.nextAfter({ model: "qwen3.5:latest", provider: "ollama" }, "text");
		expect(next).toEqual(fo.resolve("eight:latest", "text"));
		expect(next?.provider).toBe("openrouter");
	});

	test("the chain's end is null, as the old same-entry check gave", () => {
		const fo = fresh(false, "local-first");
		fo.markDown("eight:latest", "ollama");
		fo.markDown("qwen3.5:latest", "ollama");
		// A Mac with the Apple Foundation bridge puts it at every chain's head.
		fo.markDown("apple-foundationmodel", "apple-foundation");
		expect(fo.nextAfter({ model: "qwen3.5:latest", provider: "ollama" }, "text")).toBeNull();
	});
});
