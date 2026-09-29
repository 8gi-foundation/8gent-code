/**
 * Calibration tests. Pure math on synthetic samples, plus a check that the
 * checked-in calibration/*.json files are exactly what the fitter produces
 * from the eval result file they name.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CALIBRATION_DIR,
	type Calibration,
	P_EPS,
	type Sample,
	applyCalibration,
	calibratedVerdict,
	calibrationFileName,
	fitCalibration,
	fitScaling,
	fitThresholds,
	leaveOneOut,
	leaveOneOutRows,
	loadCalibration,
	newestPerBackendModel,
	logit,
	modelSlug,
	rawFromCalibrated,
	sigmoid,
	toRawGuardOptions,
	verdictFor,
} from "./calibrate";
import { DecideError } from "./types";

// Under-confident but perfectly separated, like llama3.2:3b in the 2026-09-28 eval.
const underConfident: Sample[] = [
	...[0.25, 0.28, 0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.45].map((p) => ({ p, destructive: true })),
	...[0.07, 0.1, 0.12, 0.14, 0.15, 0.16, 0.18, 0.2, 0.21, 0.22].map((p) => ({ p, destructive: false })),
];

describe("logit / sigmoid", () => {
	it("are inverses inside the clamp", () => {
		for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) expect(sigmoid(logit(p))).toBeCloseTo(p, 12);
	});
	it("clamp 0 and 1 to finite log-odds", () => {
		expect(logit(0)).toBeCloseTo(logit(P_EPS), 12);
		expect(logit(1)).toBeCloseTo(logit(1 - P_EPS), 12);
		expect(Number.isFinite(logit(0))).toBe(true);
	});
	it("sigmoid is stable at extremes", () => {
		expect(sigmoid(1000)).toBe(1);
		expect(sigmoid(-1000)).toBe(0);
	});
});

describe("applyCalibration", () => {
	it("is the identity at temperature 1, bias 0", () => {
		for (const p of [0.01, 0.3, 0.7]) expect(applyCalibration(p, { temperature: 1, bias: 0 })).toBeCloseTo(p, 12);
	});
	it("passes NaN through so the guard fails closed", () => {
		expect(Number.isNaN(applyCalibration(Number.NaN, { temperature: 1, bias: 0 }))).toBe(true);
		expect(calibratedVerdict(Number.NaN, { temperature: 1, bias: 0, blockAbove: 0.5, escalateBand: [0.4, 0.5] })).toBe("block");
	});
});

describe("fitScaling", () => {
	it("moves an under-confident model across 0.5", () => {
		const s = fitScaling(underConfident);
		for (const x of underConfident) expect(applyCalibration(x.p, s) > 0.5).toBe(x.destructive);
		expect(s.temperature).toBeGreaterThan(0);
	});
	it("is deterministic", () => {
		expect(fitScaling(underConfident)).toEqual(fitScaling(underConfident));
	});
	it("stays finite on perfectly separable data (Platt targets)", () => {
		const s = fitScaling([
			{ p: 0.99, destructive: true },
			{ p: 0.01, destructive: false },
		]);
		expect(Number.isFinite(s.temperature) && Number.isFinite(s.bias)).toBe(true);
	});
	it("refuses a single-class set", () => {
		expect(() => fitScaling([{ p: 0.3, destructive: true }])).toThrow(DecideError);
	});
	it("refuses a set with no positive signal", () => {
		expect(() =>
			fitScaling([
				{ p: 0.1, destructive: true },
				{ p: 0.9, destructive: false },
			]),
		).toThrow(DecideError);
	});
});

describe("fitThresholds", () => {
	it("catches every training destructive command and blocks no training safe one", () => {
		const overlap: Sample[] = [
			...underConfident,
			{ p: 0.19, destructive: true },
			{ p: 0.33, destructive: false },
		];
		const fit = fitCalibration(overlap);
		for (const x of overlap) {
			const v = calibratedVerdict(x.p, fit);
			if (x.destructive) expect(v).not.toBe("allow");
			else expect(v).not.toBe("block");
		}
		expect(fit.escalateBand[0]).toBeLessThanOrEqual(fit.escalateBand[1]);
		expect(fit.blockAbove).toBe(fit.escalateBand[1]);
	});
	it("collapses to one cut when the gap is wider than twice the margin", () => {
		const s = { temperature: 1, bias: 0 };
		const t = fitThresholds(
			[
				{ p: sigmoid(3), destructive: true },
				{ p: sigmoid(-3), destructive: false },
			],
			s,
			1,
		);
		expect(t.escalateBand[0]).toBeCloseTo(0.5, 12);
		expect(t.escalateBand[1]).toBeCloseTo(0.5, 12);
	});
	it("opens a band of margin either side when classes overlap", () => {
		const s = { temperature: 1, bias: 0 };
		const t = fitThresholds(
			[
				{ p: sigmoid(-1), destructive: true },
				{ p: sigmoid(1), destructive: false },
			],
			s,
			1,
		);
		expect(t.escalateBand[0]).toBeCloseTo(sigmoid(-2), 12);
		expect(t.escalateBand[1]).toBeCloseTo(sigmoid(2), 12);
	});
});

describe("verdictFor matches guard.ts semantics", () => {
	const t = { blockAbove: 0.6, escalateBand: [0.4, 0.6] as [number, number] };
	it("band is inclusive and checked before block", () => {
		expect(verdictFor(0.4, t)).toBe("escalate");
		expect(verdictFor(0.6, t)).toBe("escalate");
		expect(verdictFor(0.61, t)).toBe("block");
		expect(verdictFor(0.39, t)).toBe("allow");
	});
	it("fails closed on invalid probabilities", () => {
		for (const q of [Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY]) expect(verdictFor(q, t)).toBe("block");
	});
});

describe("toRawGuardOptions", () => {
	it("gives the same verdict on raw pYes as calibratedVerdict", () => {
		const fit = fitCalibration(underConfident);
		const raw = toRawGuardOptions(fit);
		for (let i = 1; i < 1000; i++) {
			const p = i / 1000;
			// Skip points within float noise of a boundary.
			const nearEdge = [raw.escalateBand[0], raw.escalateBand[1]].some((b) => Math.abs(p - b) < 1e-9);
			if (nearEdge) continue;
			expect(verdictFor(p, raw)).toBe(calibratedVerdict(p, fit));
		}
	});
	it("rawFromCalibrated inverts applyCalibration", () => {
		const s = { temperature: 0.3, bias: 4 };
		for (const p of [0.01, 0.1, 0.25, 0.4]) expect(rawFromCalibrated(applyCalibration(p, s), s)).toBeCloseTo(p, 9);
	});
});

describe("leaveOneOut", () => {
	it("reports held-out verdicts, not training ones", () => {
		// One destructive outlier far below every safe score: in training it
		// would be caught by construction; held out, nothing in the other 20
		// predicts it, so it is allowed.
		const data: Sample[] = [...underConfident, { p: 0.01, destructive: true }];
		const rows = leaveOneOutRows(data);
		expect(rows[rows.length - 1].verdict).toBe("allow");
		const h = leaveOneOut(data);
		expect(h.recall).toBeCloseTo(10 / 11, 12);
		expect(h.method).toBe("leave-one-out");
		// The same point is caught when it is in the fit.
		expect(calibratedVerdict(0.01, fitCalibration(data))).not.toBe("allow");
	});
	it("scores a well separated set perfectly", () => {
		const h = leaveOneOut(underConfident);
		expect(h.recall).toBe(1);
		expect(h.falseBlock).toBe(0);
		expect(h.accuracy).toBe(1);
	});
});

describe("checked-in calibration files", () => {
	const files = fs.readdirSync(CALIBRATION_DIR).filter((f) => f.endsWith(".json"));
	it("exist", () => {
		expect(files.length).toBeGreaterThan(0);
	});
	for (const name of files) {
		it(`${name} reproduces from its eval results`, () => {
			const cal = JSON.parse(fs.readFileSync(path.join(CALIBRATION_DIR, name), "utf8")) as Calibration;
			expect(["ollama", "llamacpp", "laya"]).toContain(cal.backend);
			expect(name).toBe(`${cal.backend}-${modelSlug(cal.model)}.json`);
			expect(loadCalibration(cal.model, cal.backend)).toEqual(cal);
			const fitted = JSON.parse(fs.readFileSync(path.join(import.meta.dir, cal.fittedOn), "utf8")) as {
				summary: { model: string; backend?: string };
			};
			expect(fitted.summary.model).toBe(cal.model);
			expect(fitted.summary.backend ?? "ollama").toBe(cal.backend);
			const results = JSON.parse(fs.readFileSync(path.join(import.meta.dir, cal.fittedOn), "utf8")) as {
				rows: Array<{ destructive: boolean; pYes: number | null }>;
			};
			const samples = results.rows
				.filter((r) => typeof r.pYes === "number")
				.map((r) => ({ p: r.pYes as number, destructive: r.destructive }));
			expect(samples.length).toBe(cal.n);
			const fit = fitCalibration(samples);
			expect(fit.temperature).toBeCloseTo(cal.temperature, 4);
			expect(fit.bias).toBeCloseTo(cal.bias, 4);
			expect(fit.blockAbove).toBeCloseTo(cal.blockAbove, 4);
			expect(fit.escalateBand[0]).toBeCloseTo(cal.escalateBand[0], 4);
			expect(fit.escalateBand[1]).toBeCloseTo(cal.escalateBand[1], 4);
			const h = leaveOneOut(samples);
			expect(h.recall).toBeCloseTo(cal.heldOut.recall, 4);
			expect(h.falseBlock).toBeCloseTo(cal.heldOut.falseBlock, 4);
			expect(h.accuracy).toBeCloseTo(cal.heldOut.accuracy, 4);
		});
	}
	it("calibrates the same model separately per backend", () => {
		const selene = "hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF:latest";
		const viaOllama = loadCalibration(selene, "ollama");
		const viaLlamaCpp = loadCalibration(selene, "llamacpp");
		expect(viaOllama?.fittedOn).toBe("eval/results/2026-09-28-hf.co_AtlaAI_Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF_latest.json");
		expect(viaLlamaCpp?.fittedOn).toBe("eval/results/2026-09-28-llamacpp-hf.co_AtlaAI_Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF_latest.json");
		expect(loadCalibration("llama3.2:3b", "llamacpp")).toBeNull();
	});
	it("newestPerBackendModel keys on (backend, model); results without a backend are ollama", () => {
		const entry = (file: string, model: string, date: string, backend?: string) => ({ file, data: { summary: { model, date, backend } } });
		const picked = newestPerBackendModel([
			entry("a.json", "m", "2026-09-28T11:00:00Z"),
			entry("b.json", "m", "2026-09-28T12:00:00Z", "llamacpp"),
			entry("c.json", "m", "2026-09-28T10:00:00Z", "ollama"),
			entry("d.json", "m", "2026-09-28T13:00:00Z", "llamacpp"),
		]);
		expect(picked.map((p) => [p.backend, p.model, p.file])).toEqual([
			["ollama", "m", "a.json"],
			["llamacpp", "m", "d.json"],
		]);
	});
	it("loadCalibration returns null for an unknown model", () => {
		expect(loadCalibration("no-such-model:1b")).toBeNull();
	});
});

describe("loadCalibration rejects malformed files (guard keeps safe defaults)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decide-cal-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const model = "fixture:1b";
	const backend = "ollama";
	const valid = {
		model,
		backend,
		fittedOn: "eval/results/fixture.json",
		n: 40,
		temperature: 0.5,
		bias: 1,
		blockAbove: 0.7,
		escalateBand: [0.2, 0.7],
		heldOut: { recall: 1, falseBlock: 0, accuracy: 1, escalate: 0.1, method: "leave-one-out" },
	};
	const load = (body: unknown) => {
		fs.writeFileSync(path.join(dir, calibrationFileName(backend, model)), typeof body === "string" ? body : JSON.stringify(body));
		return loadCalibration(model, backend, dir);
	};
	const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));

	it("accepts the well-formed control", () => {
		expect(load(valid)).toEqual(valid as Calibration);
		expect(load({ ...valid, blockAbove: 0.5, escalateBand: [0.5, 0.5] })).not.toBeNull();
	});

	const bad: Array<[string, unknown]> = [
		["temperature 0", { ...valid, temperature: 0 }],
		["negative temperature", { ...valid, temperature: -1 }],
		["temperature as a string", { ...valid, temperature: "0.5" }],
		["temperature NaN via string", { ...valid, temperature: "NaN" }],
		["missing temperature", without("temperature")],
		["bias as a string", { ...valid, bias: "1" }],
		["bias null", { ...valid, bias: null }],
		["missing bias", without("bias")],
		["blockAbove above 1", { ...valid, blockAbove: 1.5, escalateBand: [0.2, 0.7] }],
		["blockAbove exactly 1 (never blocks)", { ...valid, blockAbove: 1 }],
		["blockAbove 0", { ...valid, blockAbove: 0, escalateBand: [0, 0.7] }],
		["blockAbove negative", { ...valid, blockAbove: -0.1 }],
		["blockAbove below the escalate band (allow overlaps block)", { ...valid, blockAbove: 0.1, escalateBand: [0.2, 0.7] }],
		["missing blockAbove", without("blockAbove")],
		["band low below 0", { ...valid, escalateBand: [-0.1, 0.7] }],
		["band high above 1", { ...valid, escalateBand: [0.2, 1.2] }],
		["band inverted", { ...valid, escalateBand: [0.7, 0.2] }],
		["band with three entries", { ...valid, escalateBand: [0.2, 0.5, 0.7] }],
		["band entries as strings", { ...valid, escalateBand: ["0.2", "0.7"] }],
		["missing band", without("escalateBand")],
		["missing model", without("model")],
		["missing backend", without("backend")],
		["fitted for another backend", { ...valid, backend: "llamacpp" }],
		["fitted for another model", { ...valid, model: "other:1b" }],
		["JSON null", null],
		["JSON array", [valid]],
		["not JSON", "{ temperature: 0.5"],
	];
	for (const [label, body] of bad) {
		it(`returns null: ${label}`, () => {
			expect(load(body)).toBeNull();
		});
	}
});
