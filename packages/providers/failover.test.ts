import { describe, expect, spyOn, test } from "bun:test";
import {
	type FailoverChain,
	type FailoverChannel,
	ModelFailover,
	NoAllowedProviderError,
} from "./failover";

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
			if (saved === undefined) Reflect.deleteProperty(process.env, "APFEL_BASE_URL");
			else process.env.APFEL_BASE_URL = saved;
		}
	});
});

describe("telling the user apfel was skipped (#3908)", () => {
	const apfelOnly: Record<FailoverChannel, Record<string, FailoverChain>> = {
		text: { "MiniMax-M2.7": { models: [{ model: "MiniMax-M2.7", provider: "apfel" }] } },
		computer: {},
	};

	function withApfel<T>(url: string | undefined, fn: () => T): T {
		const saved = process.env.APFEL_BASE_URL;
		if (url === undefined) Reflect.deleteProperty(process.env, "APFEL_BASE_URL");
		else process.env.APFEL_BASE_URL = url;
		try {
			return fn();
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, "APFEL_BASE_URL");
			else process.env.APFEL_BASE_URL = saved;
		}
	}

	test("logs one line naming apfel and the host only, never the full URL", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			withApfel("https://user:s3cret@skip-log.example/v1?key=abc", () => {
				new ModelFailover(apfelOnly, { allowHosted: false });
				new ModelFailover(apfelOnly, { allowHosted: false });
			});
			const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("apfel"));
			expect(lines).toEqual([
				"[failover] apfel skipped: APFEL_BASE_URL host skip-log.example is not local; set EIGHT_ALLOW_HOSTED=1 to allow.",
			]);
			expect(lines.join()).not.toContain("s3cret");
			expect(lines.join()).not.toContain("key=abc");
		} finally {
			warn.mockRestore();
		}
	});

	test("the empty-chain error says apfel was dropped and why", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const err = withApfel("https://api.minimax.io/v1", () => {
				try {
					new ModelFailover(apfelOnly, { allowHosted: false }).resolve("MiniMax-M2.7");
				} catch (e) {
					return e as Error;
				}
				return null;
			});
			expect(err).toBeInstanceOf(NoAllowedProviderError);
			expect(err?.message).toContain(
				"apfel skipped: APFEL_BASE_URL host api.minimax.io is not local",
			);
			expect(err?.message).not.toContain("https://");
		} finally {
			warn.mockRestore();
		}
	});

	test("says nothing when apfel is local or hosted is allowed", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			withApfel(undefined, () => {
				expect(new ModelFailover(apfelOnly, { allowHosted: false }).skippedNote).toBeNull();
			});
			withApfel("https://quiet.example/v1", () => {
				expect(new ModelFailover(apfelOnly, { allowHosted: true }).skippedNote).toBeNull();
			});
			expect(warn.mock.calls.length).toBe(0);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("ModelFailover cache affinity (#4500)", () => {
	const hosted = { allowHosted: true };
	const lm = { model: "ornith-1.0-9b", provider: "lmstudio" };
	const apfel = { model: "MiniMax-M2.7", provider: "apfel" };

	test("starts at the warm backend, not the chain head", () => {
		const f = new ModelFailover(chains, { ...hosted, cacheAffinity: true });
		f.noteServed("s1", "ornith-1.0-9b", apfel, 9000);
		expect(f.resolve("ornith-1.0-9b", "text", "s1")).toEqual(apfel);
		expect(f.resolve("ornith-1.0-9b", "text", "other")).toEqual(lm);
		expect(f.getEvents()).toEqual([]);
	});

	test("falls back to chain order when the warm backend is down, with coldPrefillTokens", () => {
		const f = new ModelFailover(chains, { ...hosted, cacheAffinity: true });
		f.noteServed("s1", "ornith-1.0-9b", apfel, 9000);
		f.markDown(apfel.model, apfel.provider);
		expect(f.resolve("ornith-1.0-9b", "text", "s1")).toEqual(lm);
		const [ev] = f.getEvents();
		expect(ev?.fromProvider).toBe("apfel");
		expect(ev?.toProvider).toBe("lmstudio");
		expect(ev?.reason).toBe("affinity-down");
		expect(ev?.coldPrefillTokens).toBe(9000);
	});

	test("grace retry is allowed once when re-prefill outweighs the wait", () => {
		const f = new ModelFailover(chains, {
			...hosted,
			cacheAffinity: true,
			prefillTokensPerSec: 1000,
		});
		f.noteServed("s1", "ornith-1.0-9b", apfel, 8000); // 8 s of re-prefill
		expect(f.graceRetry("s1", lm, 1500)).toBe(false); // not the warm backend
		expect(f.graceRetry("s1", apfel, 10_000)).toBe(false); // waiting costs more
		expect(f.graceRetry("s1", apfel, 1500)).toBe(true);
		expect(f.graceRetry("s1", apfel, 1500)).toBe(false); // one retry only
		f.noteServed("s1", "ornith-1.0-9b", apfel, 8000); // a served turn re-arms it
		expect(f.graceRetry("s1", apfel, 1500)).toBe(true);
	});

	test("flag off behaves exactly like today", () => {
		const off = new ModelFailover(chains, hosted);
		const base = new ModelFailover(chains, hosted);
		off.noteServed("s1", "ornith-1.0-9b", apfel, 9000);
		expect(off.resolve("ornith-1.0-9b", "text", "s1")).toEqual(base.resolve("ornith-1.0-9b"));
		off.markDown(lm.model, lm.provider);
		base.markDown(lm.model, lm.provider);
		expect(off.resolve("ornith-1.0-9b", "text", "s1")).toEqual(base.resolve("ornith-1.0-9b"));
		expect(off.graceRetry("s1", apfel, 0)).toBe(false);
		const strip = (e: { ts: number }[]) => e.map(({ ts, ...r }) => r);
		expect(strip(off.getEvents())).toEqual(strip(base.getEvents()));
		expect(off.getEvents().every((e) => e.coldPrefillTokens === undefined)).toBe(true);
	});
});
