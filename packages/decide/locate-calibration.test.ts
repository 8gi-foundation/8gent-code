/**
 * locate mode calibration tests. Pure math on synthetic samples, strict
 * loading, and a check that each checked-in calibration/locate/*.json is
 * exactly what the fitter produces from the eval result file it names.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LOCATE_CALIBRATION_DIR,
	LOCATE_MODES,
	type LocateCalibration,
	type LocateSample,
	fitLocateCalibration,
	fitLocateThreshold,
	gateMode,
	loadLocateCalibration,
	locateCalibrationTrusted,
	locateLeaveOneOut,
} from "./locate-calibration";

const s = (
	chosen: LocateSample["chosen"],
	confidence: number,
	label: LocateSample["label"],
): LocateSample => ({ chosen, confidence, label });

describe("gateMode", () => {
	it("keeps the model's mode at or above the threshold", () => {
		expect(gateMode("symbol", 0.7, 0.7)).toBe("symbol");
		expect(gateMode("path", 0.9, 0.5)).toBe("path");
	});
	it("falls back to hybrid below the threshold", () => {
		expect(gateMode("symbol", 0.69, 0.7)).toBe("hybrid");
	});
	it("falls back to hybrid on a non-finite or out-of-range confidence or threshold", () => {
		expect(gateMode("grep", Number.NaN, 0.1)).toBe("hybrid");
		expect(gateMode("grep", 1.5, 0.1)).toBe("hybrid");
		expect(gateMode("grep", 0.9, Number.NaN)).toBe("hybrid");
		expect(gateMode("grep", 0.9, -1)).toBe("hybrid");
	});
	it("falls back to hybrid for a mode it does not know", () => {
		expect(gateMode("regex" as LocateSample["chosen"], 0.99, 0.1)).toBe("hybrid");
	});
});

describe("fitLocateThreshold", () => {
	it("picks the cut that maximises gated accuracy", () => {
		// Confident answers are right, unsure ones are wrong: cut between them.
		const samples = [
			s("symbol", 0.9, "symbol"),
			s("path", 0.8, "path"),
			s("grep", 0.4, "symbol"),
			s("path", 0.3, "grep"),
		];
		const t = fitLocateThreshold(samples);
		expect(t).toBeGreaterThan(0.4);
		expect(t).toBeLessThanOrEqual(0.8);
		expect(samples.filter((x) => gateMode(x.chosen, x.confidence, t) === x.label).length).toBe(2);
	});
	it("prefers the higher cut on a tie (more queries stay on hybrid)", () => {
		// 0.6, 0.7 and 0.8 all score 3 of 4 (0.9 scores 2): the highest of them wins.
		const samples = [
			s("symbol", 0.9, "symbol"),
			s("path", 0.8, "path"),
			s("grep", 0.7, "hybrid"),
			s("path", 0.6, "path"),
		];
		expect(fitLocateThreshold(samples)).toBe(0.8);
	});
	it("never trusts a model that is always wrong", () => {
		const samples = [s("symbol", 0.95, "path"), s("grep", 0.9, "hybrid"), s("path", 0.6, "hybrid")];
		const t = fitLocateThreshold(samples);
		for (const x of samples) expect(gateMode(x.chosen, x.confidence, t)).toBe("hybrid");
	});
	it("accepts everything when every answer is right", () => {
		const samples = [s("symbol", 0.3, "symbol"), s("path", 0.25, "path")];
		expect(fitLocateThreshold(samples)).toBe(0.25);
	});
	it("throws on an empty set", () => {
		expect(() => fitLocateThreshold([])).toThrow();
	});
});

describe("locateLeaveOneOut", () => {
	it("scores each sample with a threshold fitted without it", () => {
		const samples = [
			s("symbol", 0.9, "symbol"),
			s("path", 0.85, "path"),
			s("grep", 0.3, "symbol"),
			s("path", 0.2, "grep"),
			s("hybrid", 0.5, "hybrid"),
		];
		const { rows, heldOut } = locateLeaveOneOut(samples);
		expect(rows.length).toBe(samples.length);
		for (let i = 0; i < samples.length; i++) {
			const t = fitLocateThreshold(samples.filter((_, j) => j !== i));
			expect(rows[i].threshold).toBe(t);
			expect(rows[i].gated).toBe(gateMode(samples[i].chosen, samples[i].confidence, t));
		}
		expect(heldOut.method).toBe("leave-one-out");
		expect(heldOut.accuracy).toBeCloseTo(
			rows.filter((r, i) => r.gated === samples[i].label).length / samples.length,
			12,
		);
		const accepted = rows.filter((r) => r.accepted);
		expect(heldOut.coverage).toBeCloseTo(accepted.length / samples.length, 12);
	});
});

describe("loadLocateCalibration", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locate-cal-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const good: LocateCalibration = {
		kind: "locate-mode",
		model: "tiny:1b",
		backend: "ollama",
		threshold: 0.6,
		fittedOn: "eval/results/x.json",
		n: 40,
		rawAccuracy: 0.8,
		heldOut: { accuracy: 0.8, coverage: 0.7, acceptedAccuracy: 0.9, method: "leave-one-out" },
	};
	const write = (name: string, body: unknown) =>
		fs.writeFileSync(path.join(dir, name), JSON.stringify(body));

	it("reads the file for (backend, model)", () => {
		write("ollama-tiny_1b.json", good);
		expect(loadLocateCalibration("tiny:1b", "ollama", dir)?.threshold).toBe(0.6);
	});
	it("is null when absent, for another backend, or malformed", () => {
		expect(loadLocateCalibration("absent:1b", "ollama", dir)).toBeNull();
		write("llamacpp-tiny_1b.json", good);
		expect(loadLocateCalibration("tiny:1b", "llamacpp", dir)).toBeNull();
		for (const bad of [
			{ ...good, threshold: 1.5 },
			{ ...good, threshold: Number.NaN },
			{ ...good, kind: "guard" },
			{ ...good, threshold: "0.5" },
			{ ...good, heldOut: undefined },
			{ ...good, heldOut: { ...good.heldOut, accuracy: Number.NaN } },
			[good],
		]) {
			write("ollama-bad_1b.json", Array.isArray(bad) ? bad : { ...bad, model: "bad:1b" });
			expect(loadLocateCalibration("bad:1b", "ollama", dir)).toBeNull();
		}
		fs.writeFileSync(path.join(dir, "ollama-junk_1b.json"), "{not json");
		expect(loadLocateCalibration("junk:1b", "ollama", dir)).toBeNull();
	});
});

describe("locateCalibrationTrusted", () => {
	const cal = (accuracy: number) => ({ heldOut: { accuracy } }) as LocateCalibration;
	it("trusts a model only at or above 85% held-out accuracy by default", () => {
		expect(locateCalibrationTrusted(cal(0.85))).toBe(true);
		expect(locateCalibrationTrusted(cal(0.849))).toBe(false);
		expect(locateCalibrationTrusted(cal(0.6), 0.5)).toBe(true);
	});
});

describe("checked-in locate calibration files", () => {
	const files = fs.existsSync(LOCATE_CALIBRATION_DIR)
		? fs.readdirSync(LOCATE_CALIBRATION_DIR).filter((f) => f.endsWith(".json"))
		: [];
	it("exist", () => {
		expect(files.length).toBeGreaterThan(0);
	});
	for (const name of files) {
		it(`${name} is what the fitter produces from the file it names`, () => {
			const cal = JSON.parse(
				fs.readFileSync(path.join(LOCATE_CALIBRATION_DIR, name), "utf8"),
			) as LocateCalibration;
			expect(loadLocateCalibration(cal.model, cal.backend)).not.toBeNull();
			const result = JSON.parse(
				fs.readFileSync(path.join(import.meta.dir, cal.fittedOn), "utf8"),
			) as {
				summary: { model: string; backend: string };
				rows: Array<{ label: string; model: { chosen: string; confidence: number } | null }>;
			};
			expect(result.summary.model).toBe(cal.model);
			expect(result.summary.backend).toBe(cal.backend);
			const samples = result.rows
				.filter(
					(r) => r.model && LOCATE_MODES.includes(r.model.chosen as (typeof LOCATE_MODES)[number]),
				)
				.map(
					(r) =>
						({
							chosen: r.model?.chosen,
							confidence: r.model?.confidence,
							label: r.label,
						}) as LocateSample,
				);
			const fit = fitLocateCalibration(samples);
			expect(cal.n).toBe(samples.length);
			expect(cal.threshold).toBeCloseTo(fit.threshold, 6);
			expect(cal.heldOut.accuracy).toBeCloseTo(fit.heldOut.accuracy, 4);
		});
	}
});
