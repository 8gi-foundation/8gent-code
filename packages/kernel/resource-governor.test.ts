import { describe, expect, test } from "bun:test";
import {
	DEFAULT_BUDGET_POLICY,
	ResourceGovernor,
	type ResourceSnapshot,
	type Vitals,
	decide,
} from "./resource-governor";

function snap(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
	return {
		tokens: { dailyPct: 0.1, weeklyPct: 0.1, allowed: true },
		spendUsd: { today: 0 },
		thermal: "nominal",
		cpuPct: 10,
		memPct: 30,
		loadAvg: 1,
		...overrides,
	};
}

describe("resource governor degrade policy", () => {
	test("nominal: full hedge width, cloud allowed", () => {
		const v = decide(snap(), DEFAULT_BUDGET_POLICY);
		expect(v.allow).toBe(true);
		expect(v.hedgeWidth).toBe(DEFAULT_BUDGET_POLICY.maxHedgeWidth);
		expect(v.allowCloud).toBe(true);
		expect(v.allowFree).toBe(true);
	});

	test("thermal serious -> HARD-HALT (allow=false, no free either)", () => {
		const v = decide(snap({ thermal: "serious" }), DEFAULT_BUDGET_POLICY);
		expect(v.allow).toBe(false);
		expect(v.hedgeWidth).toBe(0);
		expect(v.allowFree).toBe(false);
		expect(v.reason).toContain("thermal");
	});

	test("thermal critical -> HARD-HALT", () => {
		const v = decide(snap({ thermal: "critical" }), DEFAULT_BUDGET_POLICY);
		expect(v.allow).toBe(false);
		expect(v.allowFree).toBe(false);
	});

	test("token budget exhausted -> HARD-HALT with the budget reason", () => {
		const v = decide(
			snap({
				tokens: {
					dailyPct: 1,
					weeklyPct: 0.5,
					allowed: false,
					reason: "Daily token limit reached",
				},
			}),
			DEFAULT_BUDGET_POLICY,
		);
		expect(v.allow).toBe(false);
		expect(v.reason).toContain("Daily token limit");
	});

	test("spend ceiling hit -> halt-and-ask, free still allowed", () => {
		const v = decide(snap({ spendUsd: { today: 5 } }), DEFAULT_BUDGET_POLICY);
		expect(v.allow).toBe(false);
		expect(v.haltAndAsk).toBe(true);
		expect(v.allowFree).toBe(true);
		expect(v.allowCloud).toBe(false);
	});

	test("token pressure (>= degrade fraction) -> degrade-to-local single shot, no paid cloud", () => {
		const v = decide(
			snap({ tokens: { dailyPct: 0.85, weeklyPct: 0.2, allowed: true } }),
			DEFAULT_BUDGET_POLICY,
		);
		expect(v.allow).toBe(true);
		expect(v.hedgeWidth).toBe(1);
		expect(v.preferLocal).toBe(true);
		expect(v.allowCloud).toBe(false);
		expect(v.allowFree).toBe(true);
	});

	test("thermal fair -> degrade-to-local single shot", () => {
		const v = decide(snap({ thermal: "fair" }), DEFAULT_BUDGET_POLICY);
		expect(v.allow).toBe(true);
		expect(v.hedgeWidth).toBe(1);
		expect(v.allowCloud).toBe(false);
	});

	test("precedence: thermal critical beats spend ceiling beats token pressure", () => {
		const v = decide(
			snap({
				thermal: "critical",
				spendUsd: { today: 100 },
				tokens: { dailyPct: 0.99, weeklyPct: 0.5, allowed: true },
			}),
			DEFAULT_BUDGET_POLICY,
		);
		expect(v.reason).toContain("thermal");
		expect(v.allowFree).toBe(false); // hard halt, not halt-and-ask
	});

	test("governor composes injected vitals + usage + spend into a verdict", () => {
		const hotVitals: Vitals = { thermal: "critical", cpuPct: 99, memPct: 90, loadAvg: 12 };
		const gov = new ResourceGovernor({
			usage: {
				check: () => ({ allowed: true, dailyUsed: 0, weeklyUsed: 0, dailyPct: 0, weeklyPct: 0 }),
			} as never,
			readVitals: () => hotVitals,
			getSpendTodayUsd: () => 0,
		});
		expect(gov.thermalNominal()).toBe(false);
		expect(gov.verdict().allow).toBe(false);
	});

	test("vitals read failure fails SAFE-OPEN to nominal (does not brick a healthy machine)", () => {
		const gov = new ResourceGovernor({
			usage: {
				check: () => ({ allowed: true, dailyUsed: 0, weeklyUsed: 0, dailyPct: 0, weeklyPct: 0 }),
			} as never,
			readVitals: () => {
				throw new Error("sysctl unavailable");
			},
			getSpendTodayUsd: () => 0,
		});
		expect(gov.thermalNominal()).toBe(true);
		expect(gov.verdict().allow).toBe(true);
	});
});
