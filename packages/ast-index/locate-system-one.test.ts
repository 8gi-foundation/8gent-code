/**
 * System One routing for prose locate queries: the flag, the code-applied
 * threshold, the time limit and fail-open behaviour. No real model: fake
 * deciders and the decide package's mock backend.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Decider } from "../decide/index";
import { createDecider } from "../decide/index";
import {
	DEFAULT_LOCATE_ROUTE_TIMEOUT_MS,
	LOCATE_DEFAULT_THRESHOLD,
	LOCATE_MODE_OPTIONS,
	LOCATE_MODE_OPTION_TEXT,
	_resetLocateSystemOne,
	createProseRouter,
	defaultProseRouter,
	locateSystemOneEnabled,
} from "./locate-system-one";

const MODES: string[] = ["symbol", "grep", "path", "semantic", "hybrid"];

/** A decider whose choice answer is fixed; counts calls and records what it was asked. */
function fakeDecider(
	probabilities: number[],
	opts: { delayMs?: number; fail?: boolean; model?: string; backend?: string } = {},
) {
	const asked: { state: string; prompt: string; options: string[] }[] = [];
	const backend = {
		name: opts.backend ?? "ollama",
		model: opts.model ?? "tiny:1b",
		ask: async () => ({}) as never,
	};
	const decider = {
		backend: async () => backend,
		choice: async (state: string, prompt: string, options: string[]) => {
			asked.push({ state, prompt, options });
			if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
			if (opts.fail) throw new Error("backend exploded");
			let chosen = 0;
			for (let i = 1; i < probabilities.length; i++)
				if (probabilities[i] > probabilities[chosen]) chosen = i;
			return {
				id: "q",
				kind: "choice" as const,
				probabilities,
				chosen,
				confidence: probabilities[chosen],
				backend: backend.name,
				model: backend.model,
				latencyMs: 1,
			};
		},
	} as unknown as Decider;
	return { decider, asked };
}

const calDir = fs.mkdtempSync(path.join(os.tmpdir(), "locate-s1-cal-"));
fs.writeFileSync(
	path.join(calDir, "ollama-tiny_1b.json"),
	JSON.stringify({
		kind: "locate-mode",
		model: "tiny:1b",
		backend: "ollama",
		threshold: 0.6,
		fittedOn: "x",
		n: 1,
		rawAccuracy: 1,
		heldOut: { accuracy: 1, coverage: 1, acceptedAccuracy: 1, method: "leave-one-out" },
	}),
);
fs.writeFileSync(
	path.join(calDir, "ollama-weak_1b.json"),
	JSON.stringify({
		kind: "locate-mode",
		model: "weak:1b",
		backend: "ollama",
		threshold: 0.2,
		fittedOn: "x",
		n: 40,
		rawAccuracy: 0.25,
		heldOut: { accuracy: 0.225, coverage: 0.75, acceptedAccuracy: 0.3, method: "leave-one-out" },
	}),
);
afterAll(() => fs.rmSync(calDir, { recursive: true, force: true }));
afterEach(() => _resetLocateSystemOne());

describe("flag and time limit", () => {
	test("off unless EIGHT_SYSTEM_ONE_LOCATE is 1 or true", () => {
		expect(locateSystemOneEnabled({})).toBe(false);
		expect(locateSystemOneEnabled({ EIGHT_SYSTEM_ONE_LOCATE: "0" })).toBe(false);
		expect(locateSystemOneEnabled({ EIGHT_SYSTEM_ONE_LOCATE: "yes" })).toBe(false);
		expect(locateSystemOneEnabled({ EIGHT_SYSTEM_ONE_LOCATE: "1" })).toBe(true);
		expect(locateSystemOneEnabled({ EIGHT_SYSTEM_ONE_LOCATE: " TRUE " })).toBe(true);
		// The shell guard's flag does not turn locate routing on.
		expect(locateSystemOneEnabled({ EIGHT_SYSTEM_ONE: "1" })).toBe(false);
	});
	test("the time limit is 500 ms", () => {
		expect(DEFAULT_LOCATE_ROUTE_TIMEOUT_MS).toBe(500);
	});
	test("defaultProseRouter is null with the flag off, and builds no decider", () => {
		expect(defaultProseRouter({})).toBeNull();
	});
	test("defaultProseRouter is a router with the flag on", () => {
		expect(typeof defaultProseRouter({ EIGHT_SYSTEM_ONE_LOCATE: "1" })).toBe("function");
	});
});

describe("createProseRouter", () => {
	test("asks one choice question over the five modes, with the query as state", async () => {
		const { decider, asked } = fakeDecider([0.9, 0.025, 0.025, 0.025, 0.025]);
		await createProseRouter({ decider, calibrationDir: calDir })("the class that runs tools");
		expect(asked.length).toBe(1);
		expect(asked[0].options).toEqual(LOCATE_MODE_OPTION_TEXT);
		expect(LOCATE_MODE_OPTION_TEXT.length).toBe(MODES.length);
		expect([...LOCATE_MODE_OPTIONS] as string[]).toEqual(MODES);
		expect(asked[0].state).toContain("the class that runs tools");
	});

	test("keeps the model's mode at or above the calibrated threshold", async () => {
		const { decider } = fakeDecider([0.05, 0.05, 0.8, 0.05, 0.05]);
		const r = await createProseRouter({ decider, calibrationDir: calDir })("the brand guide");
		expect(r).toMatchObject({ mode: "path", chosen: "path", reason: "model", threshold: 0.6 });
		expect(r.confidence).toBeCloseTo(0.8, 12);
		expect(r.backend).toBe("ollama");
		expect(r.model).toBe("tiny:1b");
	});

	test("below the threshold the answer is hybrid, and says why", async () => {
		const { decider } = fakeDecider([0.5, 0.2, 0.1, 0.1, 0.1]);
		const r = await createProseRouter({ decider, calibrationDir: calDir })("session manager");
		expect(r).toMatchObject({
			mode: "hybrid",
			chosen: "symbol",
			reason: "below_threshold",
			threshold: 0.6,
		});
	});

	test("an explicit threshold overrides the calibration file", async () => {
		const { decider } = fakeDecider([0.5, 0.2, 0.1, 0.1, 0.1]);
		const r = await createProseRouter({ decider, threshold: 0.4 })("session manager");
		expect(r).toMatchObject({ mode: "symbol", reason: "model", threshold: 0.4 });
	});

	test("an uncalibrated model is still asked, and gated at the default threshold", async () => {
		expect(LOCATE_DEFAULT_THRESHOLD).toBe(0.9);
		const sure = fakeDecider([0.95, 0, 0, 0, 0.05], { model: "other:7b" });
		const r = await createProseRouter({ decider: sure.decider, calibrationDir: calDir })(
			"where is the store",
		);
		expect(sure.asked.length).toBe(1);
		expect(r).toMatchObject({
			mode: "symbol",
			reason: "model",
			threshold: 0.9,
			calibrated: false,
			model: "other:7b",
		});
		const unsure = fakeDecider([0.8, 0.2, 0, 0, 0], { model: "other:7b" });
		const r2 = await createProseRouter({ decider: unsure.decider, calibrationDir: calDir })(
			"where is the store",
		);
		expect(unsure.asked.length).toBe(1);
		expect(r2).toMatchObject({ mode: "hybrid", reason: "below_threshold", calibrated: false });
	});

	test("a calibrated model is asked whatever its held-out accuracy, and gated at its threshold", async () => {
		const { decider, asked } = fakeDecider([0.3, 0.2, 0.2, 0.2, 0.1], { model: "weak:1b" });
		const r = await createProseRouter({ decider, calibrationDir: calDir })("where is the store");
		expect(asked.length).toBe(1);
		expect(r).toMatchObject({ mode: "symbol", reason: "model", threshold: 0.2, calibrated: true });
	});

	test("a slow model is cut off at the time limit: hybrid", async () => {
		const { decider } = fakeDecider([0.99, 0, 0, 0, 0.01], { delayMs: 200 });
		const t0 = performance.now();
		const r = await createProseRouter({ decider, calibrationDir: calDir, timeoutMs: 30 })(
			"anything",
		);
		expect(performance.now() - t0).toBeLessThan(150);
		expect(r).toMatchObject({ mode: "hybrid", reason: "timeout" });
	});

	test("a throwing backend or decider factory fails open to hybrid", async () => {
		const { decider } = fakeDecider([1, 0, 0, 0, 0], { fail: true });
		const r = await createProseRouter({ decider, calibrationDir: calDir })("anything");
		expect(r).toMatchObject({ mode: "hybrid", reason: "error" });
		expect(r.error).toContain("backend exploded");
		const r2 = await createProseRouter({
			decider: async () => {
				throw new Error("no backend");
			},
			calibrationDir: calDir,
		})("anything");
		expect(r2).toMatchObject({ mode: "hybrid", reason: "error" });
	});

	test("a malformed answer (bad index or confidence) fails open to hybrid", async () => {
		const { decider } = fakeDecider([Number.NaN, 0, 0, 0, 0]);
		const r = await createProseRouter({ decider, threshold: 0.1 })("anything");
		expect(r.mode).toBe("hybrid");
	});

	test("semantic is a valid gated mode (retrieval maps it later)", async () => {
		const { decider } = fakeDecider([0, 0, 0, 0.9, 0.1]);
		const r = await createProseRouter({ decider, calibrationDir: calDir })(
			"how is data kept private",
		);
		expect(r).toMatchObject({ mode: "semantic", reason: "model" });
	});

	test("works end to end on the decide package's mock backend", async () => {
		const decider = createDecider({ backend: "mock" });
		const r = await createProseRouter({ decider, threshold: 0 })("grep for it");
		expect(MODES).toContain(r.mode);
		expect(r.backend).toBe("mock");
		expect(r.reason).toBe("model");
	});
});
