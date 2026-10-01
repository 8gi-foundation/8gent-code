/**
 * #3289: `/provider openrouter` then `/model auto:free` ran a PAID model.
 * The OpenRouter list the TUI loads holds real ids, never the alias, so
 * autoSelectModel swapped auto:free for the list's best pick; and the agent
 * would have sent the literal "auto:free" anyway. These pin the fix: the alias
 * survives selection, is resolved to a real ":free" id when the agent is
 * built, and never falls back to a paid one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	findBestFreeModel,
	resetFreeModelCache,
	resolveModel,
} from "../../../../packages/providers/index.js";
import { AUTO_FREE, autoSelectModel, resolveAgentModel } from "./model-selection.js";

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

afterEach(() => resetFreeModelCache());

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
			resolveModel(m, { strict: true, fetchImpl: fakeFetch({ data: [{ id: "openai/gpt-4o" }] }) }),
		);
		expect(r).toEqual({ ok: false, reason: "OpenRouter lists no free models right now" });
	});

	test("no network: fails with the reason, no guessed id", async () => {
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
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

	test("findBestFreeModel does not cache a failure", async () => {
		expect("error" in (await findBestFreeModel(fakeFetch({}, 503)))).toBe(true);
		expect(await findBestFreeModel(fakeFetch(LIVE_LIKE))).toEqual({
			model: "qwen/qwen3-coder:free",
		});
	});
});
