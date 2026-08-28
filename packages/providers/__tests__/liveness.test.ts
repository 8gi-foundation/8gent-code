/**
 * Liveness probe tests.
 *
 * Every case here is a failure that actually happened on James's machine on
 * 2026-08-28, not a hypothetical. The measured numbers are in the PR body.
 */

import { describe, expect, it } from "bun:test";
import { LivenessRegistry, type ProbeResult, type ProbeTarget, probeCompletion } from "../liveness";

const T = (provider: string, model = "m"): ProbeTarget => ({
	provider,
	model,
	baseUrl: "http://127.0.0.1:1/v1",
});

function stub(partial: Partial<ProbeResult>) {
	return async (t: ProbeTarget): Promise<ProbeResult> => ({
		...t,
		outcome: "alive",
		latencyMs: 10,
		detail: "",
		ts: Date.now(),
		...partial,
	});
}

describe("liveness: routing is earned, never advertised", () => {
	it("refuses to route to a target that was never probed", () => {
		// Default-closed. An unprobed provider is not a working provider, and
		// this is the assertion that stops metadata from ever authorising a route.
		const reg = new LivenessRegistry();
		expect(reg.isRoutable(T("apfel"))).toBe(false);
	});

	it("refuses to route on a stale pass", async () => {
		let clock = 1_000_000;
		const reg = new LivenessRegistry({
			maxAgeMs: 30_000,
			now: () => clock,
			probe: async (t) => ({ ...t, outcome: "alive", latencyMs: 5, detail: "", ts: clock }),
		});
		await reg.check(T("lmstudio"));
		expect(reg.isRoutable(T("lmstudio"))).toBe(true);
		clock += 31_000;
		expect(reg.isRoutable(T("lmstudio"))).toBe(false);
	});
});

describe("liveness: the three failure modes stay distinct", () => {
	it("classifies a hang as timeout, not as a generic error", async () => {
		// Ollama, 2026-08-28: qwen3.8:27b-mlx wedged in "Stopping...", every
		// model on the daemon timed out at 90s including a 688MB one.
		const reg = new LivenessRegistry({
			probe: stub({ outcome: "timeout", latencyMs: 90_000, detail: "no response within 90000ms" }),
		});
		const r = await reg.check(T("ollama", "llama3.2:3b"));
		expect(r.outcome).toBe("timeout");
		expect(reg.isRoutable(T("ollama", "llama3.2:3b"))).toBe(false);
	});

	it("classifies an honest refusal as http_error and still declines it", async () => {
		// apfel, 2026-08-28: HTTP 500 "Apple Intelligence is not enabled." in
		// 348ms. Fast and truthful, and still not routable.
		const reg = new LivenessRegistry({
			probe: stub({
				outcome: "http_error",
				latencyMs: 348,
				detail: "HTTP 500 Apple Intelligence is not enabled.",
			}),
		});
		const r = await reg.check(T("apfel", "apple-foundationmodel"));
		expect(r.outcome).toBe("http_error");
		expect(reg.isRoutable(T("apfel", "apple-foundationmodel"))).toBe(false);
	});

	it("treats HTTP 200 with an empty completion as a failure, not a pass", async () => {
		// A `res.ok` check scores this as success. It is not success.
		const reg = new LivenessRegistry({
			probe: stub({ outcome: "empty", latencyMs: 12, detail: "HTTP 200 with empty completion" }),
		});
		const r = await reg.check(T("ghost"));
		expect(r.outcome).toBe("empty");
		expect(reg.isRoutable(T("ghost"))).toBe(false);
	});
});

describe("liveness: tool routing excludes unproven models by construction", () => {
	it("does not infer tool capability from a passing text probe", async () => {
		// #2894: qwen3.8:27b-mlx answers text fine and hangs forever on tools.
		// A text pass must therefore grant nothing.
		const reg = new LivenessRegistry({ probe: stub({ outcome: "alive", latencyMs: 40 }) });
		await reg.check(T("ollama", "qwen3.8:27b-mlx"));
		expect(reg.isRoutable(T("ollama", "qwen3.8:27b-mlx"))).toBe(true);
		expect(reg.isRoutable(T("ollama", "qwen3.8:27b-mlx"), { tools: true })).toBe(false);
	});

	it("grants tool routing only after a real tools payload returns", async () => {
		const reg = new LivenessRegistry({
			toolsProbe: stub({ outcome: "alive", latencyMs: 900, toolsOk: true }),
		});
		await reg.check(T("lmstudio", "ornith-1.0-9b"), { tools: true });
		expect(reg.isRoutable(T("lmstudio", "ornith-1.0-9b"), { tools: true })).toBe(true);
	});

	it("withholds tool routing when the tools payload hangs", async () => {
		const reg = new LivenessRegistry({
			toolsProbe: stub({ outcome: "timeout", latencyMs: 12_000, toolsOk: false }),
		});
		await reg.check(T("ollama", "qwen3.8:27b-mlx"), { tools: true });
		expect(reg.isRoutable(T("ollama", "qwen3.8:27b-mlx"), { tools: true })).toBe(false);
	});
});

describe("liveness: latency budgets", () => {
	it("keeps a slow-but-alive provider off the quick-answers route", async () => {
		// Alive is not the same as fast. A 25s cold load is a legitimate answer
		// for a long-horizon task and a dead 25 seconds for a quick question.
		const reg = new LivenessRegistry({ probe: stub({ outcome: "alive", latencyMs: 25_000 }) });
		await reg.check(T("ollama", "qwen2.5vl:7b"));
		expect(reg.isRoutable(T("ollama", "qwen2.5vl:7b"))).toBe(true);
		expect(reg.isRoutable(T("ollama", "qwen2.5vl:7b"), { maxLatencyMs: 2_500 })).toBe(false);
	});
});

describe("liveness: pick() skips the dead and lands on the live", () => {
	it("walks past a hang and an HTTP 500 to the one provider that answers", async () => {
		// The exact live ordering on 2026-08-28.
		const outcomes: Record<string, Partial<ProbeResult>> = {
			ollama: { outcome: "timeout", latencyMs: 90_000 },
			apfel: { outcome: "http_error", latencyMs: 348 },
			lmstudio: { outcome: "alive", latencyMs: 1_172 },
		};
		const reg = new LivenessRegistry({
			probe: async (t) => ({
				...t,
				latencyMs: 0,
				detail: "",
				ts: Date.now(),
				outcome: "unreachable",
				...outcomes[t.provider],
			}),
		});
		const picked = await reg.pick([T("ollama"), T("apfel"), T("lmstudio")]);
		expect(picked?.provider).toBe("lmstudio");
	});

	it("returns null rather than guessing when nothing is alive", async () => {
		const reg = new LivenessRegistry({ probe: stub({ outcome: "timeout", latencyMs: 10_000 }) });
		expect(await reg.pick([T("a"), T("b")])).toBeNull();
	});
});

describe("liveness: backoff protects against paying for a hang repeatedly", () => {
	it("backs off a timeout harder than a refused connection", async () => {
		let clock = 0;
		let calls = 0;
		const mk = (outcome: ProbeResult["outcome"]) =>
			new LivenessRegistry({
				maxAgeMs: 1,
				now: () => clock,
				probe: async (t) => {
					calls++;
					return { ...t, outcome, latencyMs: 1, detail: "", ts: clock };
				},
			});

		clock = 0;
		calls = 0;
		const refused = mk("unreachable");
		await refused.check(T("dead"));
		clock = 20_000; // past unreachable's window, inside timeout's
		await refused.check(T("dead"));
		expect(calls).toBe(2);

		clock = 0;
		calls = 0;
		const hung = mk("timeout");
		await hung.check(T("hung"));
		clock = 20_000;
		await hung.check(T("hung"));
		expect(calls).toBe(1); // still cooling off - a retry would cost another window
	});
});

describe("liveness: real network, no mocks", () => {
	it("declines to route to a port with nothing listening", async () => {
		// The dead-route proof. 11500 is the port packages/settings/defaults.ts
		// shipped for apfel; the bridge is on 11435. Connection refused is
		// deterministic on any machine, so this is safe in CI.
		const dead: ProbeTarget = {
			provider: "apfel-misconfigured",
			model: "apple-foundationmodel",
			baseUrl: "http://127.0.0.1:11500/v1",
		};
		const r = await probeCompletion(dead, 3_000);
		expect(r.outcome).toBe("unreachable");
		expect(r.outcome).not.toBe("alive");

		const reg = new LivenessRegistry();
		await reg.check(dead);
		expect(reg.isRoutable(dead)).toBe(false);
		expect(reg.isRoutable(dead, { tools: true })).toBe(false);
	}, 10_000);
});
