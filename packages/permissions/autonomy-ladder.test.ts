import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_RUNG,
	type MakerCheckerContext,
	Rung,
	checkerPassed,
	evaluateRung,
	getAuditLogPath,
	signApprovalGrant,
} from "./autonomy-ladder";
import { matchNeverAuto } from "./go-deny-list";
import { loadOrCreateKey, verify } from "./goal-state-hmac";
import {
	type BudgetPolicy,
	DEFAULT_BUDGET_POLICY,
	evaluateBudgetPolicy,
	reconcileBudgetPolicy,
} from "./policy-engine";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-test-"));
process.env.EIGHT_DATA_DIR = TMP_DIR;

// A distinct maker/checker pair with a PASS verdict - the happy path.
const PASSING_MC: MakerCheckerContext = {
	maker: "zara",
	checker: "solomon",
	verdict: "PASS",
	approver: "james",
	reversible: true,
};

describe("Autonomy ladder - default rung", () => {
	test("default rung is Observe (most conservative)", () => {
		expect(DEFAULT_RUNG).toBe(Rung.Observe);
	});

	test("an unconfigured domain defaults to Observe and allows read-only", () => {
		const d = evaluateRung({ domain: "inbound", action: "summarise" });
		expect(d.allowed).toBe(true);
		expect(d.effectiveRung).toBe(Rung.Observe);
	});
});

describe("Autonomy ladder - rung 2 requires approval", () => {
	test("rung 2 (Draft) holds: requiresApproval, nothing executes", () => {
		const d = evaluateRung({
			domain: "social",
			rung: Rung.Draft,
			action: "post_to_x",
			maker: PASSING_MC,
		});
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
		expect(d.effectiveRung).toBe(Rung.Draft);
		expect(d.reason).toMatch(/rung-2-draft/);
	});

	test("rung 2 holds even with a passing checker - it is a HOLD by design", () => {
		const d = evaluateRung({
			domain: "social",
			rung: Rung.Draft,
			action: "post_to_x",
			maker: PASSING_MC,
			budgetOk: true,
		});
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
	});
});

describe("Autonomy ladder - rung 3 maker-checker precondition", () => {
	test("rung 3 with no checker pass requires approval", () => {
		const d = evaluateRung({
			domain: "code",
			rung: Rung.ActWithApproval,
			action: "apply_patch",
			maker: { maker: "rishi", checker: "rishi", verdict: "PASS", reversible: true },
		});
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
		expect(d.reason).toMatch(/maker != checker/i);
	});

	test("rung 3 NEVER auto-fires even with a passing checker - holds for James", () => {
		const d = evaluateRung({
			domain: "code",
			rung: Rung.ActWithApproval,
			action: "apply_patch",
			maker: PASSING_MC,
		});
		// Passing checker, but still requiresApproval - the human is the second signature.
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
		expect(d.reason).toMatch(/awaiting James/i);
	});
});

describe("Maker != checker guarantee", () => {
	test("checkerPassed is false when maker == checker", () => {
		expect(checkerPassed({ maker: "zara", checker: "zara", verdict: "PASS" })).toBe(false);
	});

	test("checkerPassed is false when verdict is FAIL", () => {
		expect(checkerPassed({ maker: "zara", checker: "solomon", verdict: "FAIL" })).toBe(false);
	});

	test("checkerPassed is false when either identity is missing", () => {
		expect(checkerPassed({ checker: "solomon", verdict: "PASS" })).toBe(false);
		expect(checkerPassed({ maker: "zara", verdict: "PASS" })).toBe(false);
	});

	test("checkerPassed is true only for distinct maker/checker + PASS", () => {
		expect(checkerPassed({ maker: "zara", checker: "solomon", verdict: "PASS" })).toBe(true);
	});

	test("rung 4 with maker == checker can NEVER auto - caps to require_approval", () => {
		const d = evaluateRung({
			domain: "inbound",
			rung: Rung.AutoWithinBudget,
			action: "triage",
			maker: { maker: "zara", checker: "zara", verdict: "PASS", reversible: true },
			budgetOk: true,
		});
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
	});

	test("matchNeverAuto flags maker == checker", () => {
		const r = matchNeverAuto({ maker: "zara", checker: "zara", reversible: true });
		expect(r.neverAuto).toBe(true);
		expect(r.classes).toContain("maker-equals-checker");
	});

	test("signApprovalGrant rejects maker == checker", () => {
		expect(() =>
			signApprovalGrant({
				action: "post",
				domain: "social",
				maker: "zara",
				checker: "zara",
				verdict: "PASS",
				approver: "james",
				reversible: true,
			}),
		).toThrow(/maker != checker/i);
	});

	test("signApprovalGrant rejects maker as its own approver", () => {
		expect(() =>
			signApprovalGrant({
				action: "post",
				domain: "social",
				maker: "zara",
				checker: "solomon",
				verdict: "PASS",
				approver: "zara",
				reversible: true,
			}),
		).toThrow(/own approver/i);
	});

	test("signApprovalGrant produces a verifiable HMAC grant for a valid maker-checker", () => {
		const key = loadOrCreateKey();
		const grant = signApprovalGrant(
			{
				action: "post",
				domain: "social",
				maker: "zara",
				checker: "solomon",
				verdict: "PASS",
				approver: "james",
				reversible: true,
			},
			key,
		);
		expect(verify(grant, key)).toBe(true);
		// Tamper with the approver -> signature must fail.
		const tampered = { ...grant, payload: { ...grant.payload, approver: "mallory" } };
		expect(verify(tampered, key)).toBe(false);
	});
});

describe("Irreversible / under-James's-name caps at rung 3", () => {
	test("irreversible action configured at rung 4 caps to rung 3 (no auto)", () => {
		const d = evaluateRung({
			domain: "code",
			rung: Rung.AutoWithinBudget,
			action: "prod_deploy",
			maker: { maker: "rishi", checker: "solomon", verdict: "PASS", reversible: false },
			budgetOk: true,
		});
		expect(d.effectiveRung).toBe(Rung.ActWithApproval);
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
	});

	test("under-James's-name action configured at rung 4 caps to rung 3", () => {
		const d = evaluateRung({
			domain: "social",
			rung: Rung.AutoWithinBudget,
			action: "post_opinion",
			maker: { ...PASSING_MC, underJamesName: true },
			budgetOk: true,
		});
		expect(d.effectiveRung).toBe(Rung.ActWithApproval);
		expect(d.allowed).toBe(false);
	});

	test("matchNeverAuto flags irreversible and under-James's-name", () => {
		expect(matchNeverAuto({ reversible: false, maker: "a", checker: "b" }).classes).toContain(
			"irreversible",
		);
		expect(matchNeverAuto({ underJamesName: true, maker: "a", checker: "b" }).classes).toContain(
			"under-james-name",
		);
	});
});

describe("Rung 4 auto - only the fully-safe path allows", () => {
	test("reversible + distinct checker PASS + budgetOk allows (the only auto path)", () => {
		const d = evaluateRung({
			domain: "inbound",
			rung: Rung.AutoWithinBudget,
			action: "triage_file",
			maker: PASSING_MC,
			budgetOk: true,
		});
		expect(d.allowed).toBe(true);
		expect(d.effectiveRung).toBe(Rung.AutoWithinBudget);
	});

	test("rung 4 without budgetOk cannot auto", () => {
		const d = evaluateRung({
			domain: "inbound",
			rung: Rung.AutoWithinBudget,
			action: "triage_file",
			maker: PASSING_MC,
			budgetOk: false,
		});
		expect(d.allowed).toBe(false);
		expect(d.requiresApproval).toBe(true);
	});

	test("rung 4 with non-reversible cannot auto", () => {
		const d = evaluateRung({
			domain: "inbound",
			rung: Rung.AutoWithinBudget,
			action: "triage_file",
			maker: { maker: "zara", checker: "solomon", verdict: "PASS", reversible: false },
			budgetOk: true,
		});
		expect(d.allowed).toBe(false);
	});
});

describe("Audit trail", () => {
	beforeEach(() => {
		// Clear the audit log between assertions that read it.
		try {
			fs.rmSync(getAuditLogPath(), { force: true });
		} catch {
			/* ignore */
		}
	});

	test("every rung decision appends one audit line with the required fields", () => {
		evaluateRung({
			domain: "social",
			rung: Rung.ActWithApproval,
			action: "post_reply",
			channel: "x",
			maker: PASSING_MC,
		});
		const raw = fs.readFileSync(getAuditLogPath(), "utf-8").trim();
		const lines = raw.split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const rec = JSON.parse(lines[0]);
		expect(rec.op).toBe("rung");
		expect(rec.domain).toBe("social");
		expect(rec.maker).toBe("zara");
		expect(rec.checker).toBe("solomon");
		expect(rec.disposition).toBe("require_approval");
		expect(typeof rec.ts).toBe("string");
	});
});

describe("Budget policy - at-cap behaviour", () => {
	test("defaults: token=degrade, spend=ask, thermal=halt; cloud spend default $0", () => {
		expect(DEFAULT_BUDGET_POLICY.atCap.token).toBe("degrade");
		expect(DEFAULT_BUDGET_POLICY.atCap.spend).toBe("ask");
		expect(DEFAULT_BUDGET_POLICY.atCap.thermal).toBe("halt");
		expect(DEFAULT_BUDGET_POLICY.maxSpendPerDayUsd).toBe(0);
	});

	test("within all caps => withinBudget", () => {
		const r = evaluateBudgetPolicy("run1", {
			tokensToday: 1000,
			spendTodayUsd: 0,
			thermalPct: 40,
		});
		expect(r.withinBudget).toBe(true);
	});

	test("token over cap => degrade-to-local", () => {
		const r = evaluateBudgetPolicy("run1", {
			tokensToday: DEFAULT_BUDGET_POLICY.maxTokensPerDay + 1,
			spendTodayUsd: 0,
			thermalPct: 10,
		});
		expect(r.withinBudget).toBe(false);
		if (!r.withinBudget) {
			expect(r.axis).toBe("token");
			expect(r.action).toBe("degrade");
		}
	});

	test("spend over cap => halt-and-ask", () => {
		const r = evaluateBudgetPolicy("run1", {
			tokensToday: 0,
			spendTodayUsd: 5,
			thermalPct: 10,
		});
		expect(r.withinBudget).toBe(false);
		if (!r.withinBudget) {
			expect(r.axis).toBe("spend");
			expect(r.action).toBe("ask");
		}
	});

	test("thermal over cap => HARD HALT, and checked first (most severe)", () => {
		const r = evaluateBudgetPolicy("run1", {
			// All three breached - thermal must win.
			tokensToday: DEFAULT_BUDGET_POLICY.maxTokensPerDay + 1,
			spendTodayUsd: 5,
			thermalPct: 99,
		});
		expect(r.withinBudget).toBe(false);
		if (!r.withinBudget) {
			expect(r.axis).toBe("thermal");
			expect(r.action).toBe("halt");
		}
	});
});

describe("Budget policy - tighten not widen", () => {
	const current: BudgetPolicy = DEFAULT_BUDGET_POLICY;

	test("a proposal to TIGHTEN is accepted", () => {
		const { policy, widened } = reconcileBudgetPolicy(current, {
			maxTokensPerDay: 100,
			maxThermalPct: 50,
		});
		expect(policy.maxTokensPerDay).toBe(100);
		expect(policy.maxThermalPct).toBe(50);
		expect(widened).toEqual([]);
	});

	test("a proposal to WIDEN is clamped back and flagged", () => {
		const { policy, widened } = reconcileBudgetPolicy(current, {
			maxTokensPerDay: current.maxTokensPerDay + 1_000_000,
			maxSpendPerDayUsd: 50,
			maxThermalPct: 99,
		});
		// Every widened axis stays at the (tighter) current value.
		expect(policy.maxTokensPerDay).toBe(current.maxTokensPerDay);
		expect(policy.maxSpendPerDayUsd).toBe(current.maxSpendPerDayUsd);
		expect(policy.maxThermalPct).toBe(current.maxThermalPct);
		expect(widened).toContain("maxTokensPerDay");
		expect(widened).toContain("maxSpendPerDayUsd");
		expect(widened).toContain("maxThermalPct");
	});

	test("at-cap actions are policy-fixed; a proposal cannot soften them", () => {
		const { policy } = reconcileBudgetPolicy(current, {});
		expect(policy.atCap.thermal).toBe("halt");
	});
});
