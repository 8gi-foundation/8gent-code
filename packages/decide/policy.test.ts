import { describe, expect, test } from "bun:test";
import {
	type CalibrationRow,
	DEFER_ALL,
	type Thresholds,
	classAnswer,
	countErrors,
	cpInterval,
	cpLower,
	cpUpper,
	fitThresholds,
	studentAnswer,
	withinBudget,
} from "./policy";

describe("Clopper-Pearson (reference: scipy.stats.beta.ppf)", () => {
	test("one-sided 95% upper bounds", () => {
		expect(cpUpper(0, 961)).toBeCloseTo(0.0031124534991549017, 10);
		expect(cpUpper(1, 961)).toBeCloseTo(0.004926778312971285, 10);
		expect(cpUpper(2, 961)).toBeCloseTo(0.006536666896067376, 10);
		expect(cpUpper(3, 95)).toBeCloseTo(0.07959541015980841, 10);
		expect(cpUpper(48, 961)).toBeCloseTo(0.06309685351814527, 10);
	});
	test("lower bounds and two-sided interval", () => {
		expect(cpLower(0, 961)).toBe(0);
		expect(cpLower(10, 239)).toBeCloseTo(0.022873004732446592, 10);
		const [lo, hi] = cpInterval(1, 961);
		expect(lo).toBeCloseTo(2.6344926623234886e-5, 10);
		expect(hi).toBeCloseTo(0.005783984190410071, 10);
	});
	test("edges", () => {
		expect(cpUpper(5, 5)).toBe(1);
		expect(cpUpper(0, 0)).toBe(1);
	});
});

const T: Thresholds = { allow: 0.9, ask: 0.8, block: 0.7 };

describe("studentAnswer", () => {
	const base = { ood: false, truncated: false, rule: "pass" as const };
	test("answers the argmax only when it clears its class threshold", () => {
		expect(classAnswer([0.95, 0.04, 0.01], T)).toBe("allow");
		expect(classAnswer([0.85, 0.1, 0.05], T)).toBe("defer");
		expect(classAnswer([0.1, 0.1, 0.8], T)).toBe("block");
		expect(classAnswer([Number.NaN, 0, 1], T)).toBe("defer");
	});
	test("OOD, truncation, a block rule, or no forms always defer", () => {
		const f = [[0.99, 0.005, 0.005]];
		expect(studentAnswer({ ...base, forms: f, ood: true }, T)).toBe("defer");
		expect(studentAnswer({ ...base, forms: f, truncated: true }, T)).toBe("defer");
		expect(studentAnswer({ ...base, forms: f, rule: "block" }, T)).toBe("defer");
		expect(studentAnswer({ ...base, forms: [] }, T)).toBe("defer");
	});
	test("an escalate rule can only make it stricter (allow becomes ask)", () => {
		expect(studentAnswer({ ...base, forms: [[0.99, 0.005, 0.005]], rule: "escalate" }, T)).toBe("ask");
		expect(studentAnswer({ ...base, forms: [[0.01, 0.01, 0.98]], rule: "escalate" }, T)).toBe("block");
	});
	test("comment-stripped form: stricter answer wins, a deferral on either defers", () => {
		expect(studentAnswer({ ...base, forms: [[0.99, 0.005, 0.005], [0.05, 0.9, 0.05]] }, T)).toBe("ask");
		expect(studentAnswer({ ...base, forms: [[0.99, 0.005, 0.005], [0.5, 0.3, 0.2]] }, T)).toBe("defer");
	});
	test("DEFER_ALL never answers", () => {
		expect(studentAnswer({ ...base, forms: [[1, 0, 0]] }, DEFER_ALL)).toBe("defer");
	});
});

function rows(spec: [number[], CalibrationRow["truth"], number][]): CalibrationRow[] {
	const out: CalibrationRow[] = [];
	for (const [p, truth, n] of spec) for (let i = 0; i < n; i++) out.push({ forms: [p], truth, ood: false, truncated: false, rule: "pass" });
	return out;
}

describe("fitThresholds", () => {
	test("a confident allow that is truly block keeps the allow threshold above it", () => {
		const cal = rows([
			[[0.99, 0.005, 0.005], "allow", 800],
			[[0.97, 0.02, 0.01], "block", 3], // severe if answered: 3/1000 breaks the 0.5% bound
			[[0.9, 0.05, 0.05], "allow", 100],
			[[0.02, 0.03, 0.95], "block", 97],
		]);
		const fit = fitThresholds(cal);
		expect(fit.thresholds.allow).toBeGreaterThan(0.97);
		expect(fit.counts.severe).toBe(0);
		expect(withinBudget(fit.counts)).toBe(true);
		expect(fit.thresholds.block).toBeLessThanOrEqual(0.95);
		expect(fit.counts.answered).toBe(897);
	});
	test("the fitted policy is always within budget, and all-defer is the fallback", () => {
		const cal = rows([
			[[0.6, 0.3, 0.1], "block", 500],
			[[0.6, 0.3, 0.1], "allow", 500],
		]);
		const fit = fitThresholds(cal);
		expect(withinBudget(fit.counts)).toBe(true);
		expect(fit.thresholds.allow).toBe(Number.POSITIVE_INFINITY);
		expect(countErrors(cal, DEFER_ALL).answered).toBe(0);
	});
	test("under about 600 rows even a zero-error policy cannot certify the 0.5% severe budget", () => {
		expect(cpUpper(0, 100)).toBeGreaterThan(0.005);
		expect(withinBudget(countErrors(rows([[[0.99, 0.005, 0.005], "allow", 100]]), DEFER_ALL))).toBe(false);
	});
	test("mild errors are bounded at 5% over all rows", () => {
		const cal = rows([
			[[0.05, 0.9, 0.05], "ask", 900],
			[[0.05, 0.9, 0.05], "allow", 100], // 10% mild if ask is answered at 0.9
		]);
		const fit = fitThresholds(cal);
		expect(fit.mildUpper).toBeLessThanOrEqual(0.05);
		expect(fit.thresholds.ask).toBe(Number.POSITIVE_INFINITY);
	});
});
