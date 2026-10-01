/**
 * #3289: `/provider openrouter` then `/model auto:free` ran a PAID model.
 * The OpenRouter list the TUI loads holds real ids, never the alias, so
 * autoSelectModel swapped auto:free for the list's best pick; and the agent
 * would have sent the literal "auto:free" anyway. These pin the fix: the alias
 * survives selection, is resolved to a real ":free" id when the agent is
 * built, and never falls back to a paid one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	findBestFreeModel,
	resetFreeModelCache,
	resolveModel,
} from "../../../../packages/providers/index.js";
import {
	AUTO_FREE,
	autoSelectModel,
	planAgentBuild,
	resolveAgentModel,
} from "./model-selection.js";

// Shaped like OpenRouter's /api/v1/models: paid ids first, two free ones.
const LIVE_LIKE = {
	data: [
		{ id: "anthropic/claude-3.5-sonnet", context_length: 200_000 },
		{ id: "openai/gpt-4o", context_length: 128_000 },
		{ id: "qwen/qwen3-coder:free", context_length: 262_144 },
		{ id: "meta-llama/llama-3.3-70b-instruct:free", context_length: 65_536 },
	],
};
const fakeFetch = (body: unknown, status = 200) =>
	(async () => Response.json(body, { status })) as unknown as typeof fetch;

const PAID_ONLY = { data: [{ id: "openai/gpt-4o" }] };
const offline = (async () => {
	throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

// Hermetic: a test that forgets to inject a fetch must never reach the real
// openrouter.ai, so the global one fails loudly.
const realFetch = globalThis.fetch;
beforeEach(() => {
	resetFreeModelCache();
	globalThis.fetch = (async () => {
		throw new Error("auto-free.test: unexpected real network call");
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	resetFreeModelCache();
});

describe("autoSelectModel keeps auto:free (#3289)", () => {
	// The paid-only list the TUI loads for `openrouter` (app.tsx drops :free ids).
	const paidList = ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-pro-1.5"];

	for (const provider of ["openrouter", "openrouter-free"]) {
		test(`${provider}: a list without auto:free does not replace it`, () => {
			expect(
				autoSelectModel({
					current: AUTO_FREE,
					currentProvider: provider,
					available: paidList,
					explicit: null,
				}),
			).toBeNull();
		});
	}

	test("other providers still auto-select when the model is not in their list", () => {
		expect(
			autoSelectModel({
				current: "gone:latest",
				currentProvider: "ollama",
				available: ["qwen3.5:latest"],
				explicit: null,
			}),
		).toBe("qwen3.5:latest");
	});
});

describe("resolveAgentModel: auto:free becomes a real free id", () => {
	test("against an OpenRouter-shaped list, the resolved id ends in :free", async () => {
		const r = await resolveAgentModel("openrouter", AUTO_FREE, (m) =>
			resolveModel(m, { strict: true, fetchImpl: fakeFetch(LIVE_LIKE) }),
		);
		expect(r).toEqual({ ok: true, model: "qwen/qwen3-coder:free" });
		if (r.ok) expect(r.model.endsWith(":free")).toBe(true);
	});

	test("no free models: fails with the reason, no paid fallback", async () => {
		const r = await resolveAgentModel("openrouter", AUTO_FREE, (m) =>
			resolveModel(m, { strict: true, fetchImpl: fakeFetch(PAID_ONLY) }),
		);
		expect(r).toEqual({ ok: false, reason: "OpenRouter lists no free models right now" });
	});

	test("no network: fails with the reason, no guessed id", async () => {
		const r = await resolveAgentModel("openrouter", AUTO_FREE, (m) =>
			resolveModel(m, { strict: true, fetchImpl: offline }),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("could not reach OpenRouter");
	});

	test("a resolver that returns a paid id is refused", async () => {
		const r = await resolveAgentModel("openrouter", AUTO_FREE, async () => ({
			model: "openai/gpt-4o",
		}));
		expect(r.ok).toBe(false);
	});

	test("anything else passes through untouched", async () => {
		expect(await resolveAgentModel("ollama", "qwen3.5:latest")).toEqual({
			ok: true,
			model: "qwen3.5:latest",
		});
		expect(await resolveAgentModel("openrouter", "openai/gpt-4o")).toEqual({
			ok: true,
			model: "openai/gpt-4o",
		});
	});
});

describe("findBestFreeModel never caches a failure", () => {
	const failures: Array<[string, typeof fetch]> = [
		["http 503", fakeFetch({}, 503)],
		["offline", offline],
		["a list with only a paid model", fakeFetch(PAID_ONLY)],
		[
			"malformed JSON",
			(async () => new Response("<html>oops", { status: 200 })) as unknown as typeof fetch,
		],
	];
	for (const [label, failing] of failures) {
		test(`${label}: fails, fails again, then the live free model comes back`, async () => {
			const first = await findBestFreeModel(failing);
			expect("error" in first).toBe(true);
			// A second failing read is still an error, not a remembered model.
			const second = await findBestFreeModel(failing);
			expect("error" in second).toBe(true);
			expect("model" in second).toBe(false);
			// The list is readable again: the real free pick, not a cached failure.
			expect(await findBestFreeModel(fakeFetch(LIVE_LIKE))).toEqual({
				model: "qwen/qwen3-coder:free",
			});
		});
	}

	test("a success is cached: a later failing read still returns it", async () => {
		expect(await findBestFreeModel(fakeFetch(LIVE_LIKE))).toEqual({
			model: "qwen/qwen3-coder:free",
		});
		expect(await findBestFreeModel(offline)).toEqual({ model: "qwen/qwen3-coder:free" });
	});

	test("the reason keeps its cause", async () => {
		expect(await findBestFreeModel(offline)).toEqual({
			error: "could not reach OpenRouter to list its free models",
		});
		expect(
			await findBestFreeModel(
				(async () => new Response("<html>oops", { status: 200 })) as unknown as typeof fetch,
			),
		).toEqual({ error: "OpenRouter model list was a bad response" });
	});
});

describe("findBestFreeModel bounds the model-list fetch", () => {
	// Honours init.signal and otherwise never answers, like a hung server.
	const hangs = ((_url: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) return; // no bound: hangs forever, and the test times out
			if (signal.aborted) return reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		})) as unknown as typeof fetch;

	test("a list request that never answers ends as {error}, marked timed out", async () => {
		const started = Date.now();
		const r = await findBestFreeModel(hangs, 50);
		expect(r).toEqual({ error: "could not reach OpenRouter to list its free models (timed out)" });
		expect(Date.now() - started).toBeLessThan(2000);
	}, 3000);
});

describe("planAgentBuild: spec in, model or notice-and-retry out (#3289)", () => {
	test("auto:free with a live list: build with the real :free id, not the alias", async () => {
		const plan = await planAgentBuild("openrouter", AUTO_FREE, (m) =>
			resolveModel(m, { strict: true, fetchImpl: fakeFetch(LIVE_LIKE) }),
		);
		expect(plan).toEqual({ kind: "build", model: "qwen/qwen3-coder:free" });
	});

	test("auto:free with no free model: wait, with a notice that says why", async () => {
		const plan = await planAgentBuild("openrouter", AUTO_FREE, (m) =>
			resolveModel(m, { strict: true, fetchImpl: offline }),
		);
		expect(plan.kind).toBe("wait");
		if (plan.kind === "wait") {
			expect(plan.notice).toStartWith(
				"No free OpenRouter model to run: could not reach OpenRouter",
			);
			expect(plan.notice).toContain("/model");
		}
	});

	test("auto:free with the default resolver and no network: wait, never a guessed id", async () => {
		// The default path reads the (stubbed, failing) global fetch.
		const plan = await planAgentBuild("openrouter", AUTO_FREE);
		expect(plan.kind).toBe("wait");
	});

	test("a plain model builds as given", async () => {
		expect(await planAgentBuild("ollama", "qwen3.5:latest")).toEqual({
			kind: "build",
			model: "qwen3.5:latest",
		});
	});
});

describe("app.tsx builds its agent from planAgentBuild (#3289 wiring)", () => {
	// The App's init effect is not unit-mountable; this pins the source
	// contract so a revert to `model: currentModel` fails here.
	const src = fs.readFileSync(path.join(import.meta.dir, "../app.tsx"), "utf-8");
	const effect = src.slice(src.indexOf("await planAgentBuild(currentProvider, currentModel)"));

	test("the plan is computed from the active spec", () => {
		expect(src).toContain("await planAgentBuild(currentProvider, currentModel)");
	});

	test("the wait branch clears the agent, shows the notice and retries", () => {
		const wait = effect.slice(0, effect.indexOf("new Agent({"));
		expect(wait).toMatch(
			/if \(_plan\.kind === "wait"\) \{[\s\S]*setAgent\(null\)[\s\S]*notify\(_initTabId, _plan\.notice\)[\s\S]*retryLater\(\)[\s\S]*return;/,
		);
	});

	test("the Agent is built with the planned model, never the raw spec", () => {
		const ctor = effect.slice(
			effect.indexOf("new Agent({"),
			effect.indexOf("});", effect.indexOf("new Agent({")),
		);
		expect(ctor).toMatch(/\bmodel: _plan\.model,/);
		expect(ctor).not.toMatch(/\bmodel: currentModel\b/);
	});
});
