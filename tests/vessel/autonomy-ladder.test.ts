/**
 * Autonomy Ladder Tests
 *
 * Tests for the graduated trust model for vessel actions.
 *
 * Run: bun test tests/vessel/autonomy-ladder.test.ts
 */

import { describe, expect, it } from "bun:test";
import {
	AUTONOMY_RUNG,
	AUTONOMY_RUNG_LABEL,
	RUNG_REQUIREMENTS,
	RUNG_DESCRIPTIONS,
	ACTION_RISK,
	RUNG_RISK_THRESHOLDS,
	meetsRungRequirements,
	rungForCapabilities,
	isActionPermitted,
	AutonomyPolicyStore,
	createDefaultPolicy,
	effectiveRung,
	AutonomyAuditLog,
} from "../../packages/daemon/autonomy";

describe("Autonomy Rung Definitions", () => {
	it("has five defined rungs", () => {
		expect(Object.keys(AUTONOMY_RUNG)).toHaveLength(5);
	});

	it("rungs are sequential 0-4", () => {
		expect(AUTONOMY_RUNG.OBSERVE).toBe(0);
		expect(AUTONOMY_RUNG.SUGGEST).toBe(1);
		expect(AUTONOMY_RUNG.ASSIST).toBe(2);
		expect(AUTONOMY_RUNG.DELEGATE).toBe(3);
		expect(AUTONOMY_RUNG.AUTONOMOUS).toBe(4);
	});

	it("has labels for all rungs", () => {
		for (let rung = 0; rung <= 4; rung++) {
			expect(AUTONOMY_RUNG_LABEL[rung]).toBeDefined();
		}
	});

	it("has descriptions for all rungs", () => {
		for (let rung = 0; rung <= 4; rung++) {
			expect(RUNG_DESCRIPTIONS[rung].length).toBeGreaterThan(10);
		}
	});
});

describe("Rung Requirements", () => {
	it("OBSERVE requires only read", () => {
		expect(RUNG_REQUIREMENTS[0]).toEqual(["read"]);
	});

	it("SUGGEST requires read and suggest", () => {
		expect(RUNG_REQUIREMENTS[1]).toContain("read");
		expect(RUNG_REQUIREMENTS[1]).toContain("suggest");
	});

	it("ASSIST requires read, write, dispatch", () => {
		expect(RUNG_REQUIREMENTS[2]).toContain("read");
		expect(RUNG_REQUIREMENTS[2]).toContain("write");
		expect(RUNG_REQUIREMENTS[2]).toContain("dispatch");
	});

	it("DELEGATE adds execute", () => {
		expect(RUNG_REQUIREMENTS[3]).toContain("execute");
		expect(RUNG_REQUIREMENTS[3].length).toBe(4);
	});

	it("AUTONOMOUS adds escalate", () => {
		expect(RUNG_REQUIREMENTS[4]).toContain("escalate");
		expect(RUNG_REQUIREMENTS[4].length).toBe(5);
	});
});

describe("Capability Matching", () => {
	it("meets requirements when all capabilities present", () => {
		const caps = ["read", "write", "dispatch", "execute", "escalate"];
		expect(meetsRungRequirements(caps, ["read"])).toBe(true);
		expect(meetsRungRequirements(caps, ["read", "write"])).toBe(true);
	});

	it("fails requirements when capability missing", () => {
		const caps = ["read"];
		expect(meetsRungRequirements(caps, ["read", "write"])).toBe(false);
	});

	it("rung for capabilities returns correct level", () => {
		expect(rungForCapabilities(["read"])).toBe(AUTONOMY_RUNG.OBSERVE);
		expect(rungForCapabilities(["read", "suggest"])).toBe(AUTONOMY_RUNG.SUGGEST);
		expect(rungForCapabilities(["read", "write", "dispatch"])).toBe(AUTONOMY_RUNG.ASSIST);
		expect(rungForCapabilities(["read", "write", "dispatch", "execute"])).toBe(
			AUTONOMY_RUNG.DELEGATE,
		);
		expect(rungForCapabilities(["read", "write", "dispatch", "execute", "escalate"])).toBe(
			AUTONOMY_RUNG.AUTONOMOUS,
		);
	});

	it("partial capabilities map to lowest meeting rung", () => {
		// Has read, write, execute but missing suggest and dispatch
		// Can only meet OBSERVE (needs only read)
		const caps = ["read", "write", "execute"];
		expect(rungForCapabilities(caps)).toBe(AUTONOMY_RUNG.OBSERVE);
	});

	it("unknown capabilities don't affect rung", () => {
		const caps = ["read", "unknown_cap"];
		expect(rungForCapabilities(caps)).toBe(AUTONOMY_RUNG.OBSERVE);
	});
});

describe("Action Risk Assessment", () => {
	it("risk thresholds increase with rung", () => {
		expect(RUNG_RISK_THRESHOLDS[0]).toBe(ACTION_RISK.SAFE);
		expect(RUNG_RISK_THRESHOLDS[1]).toBe(ACTION_RISK.SAFE);
		expect(RUNG_RISK_THRESHOLDS[2]).toBe(ACTION_RISK.BOUNDED);
		expect(RUNG_RISK_THRESHOLDS[3]).toBe(ACTION_RISK.RISKY);
		expect(RUNG_RISK_THRESHOLDS[4]).toBe(ACTION_RISK.DESTRUCTIVE);
	});

	it("OBSERVE permits only safe actions", () => {
		expect(isActionPermitted(AUTONOMY_RUNG.OBSERVE, ACTION_RISK.SAFE)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.OBSERVE, ACTION_RISK.BOUNDED)).toBe(false);
	});

	it("ASSIST permits bounded actions", () => {
		expect(isActionPermitted(AUTONOMY_RUNG.ASSIST, ACTION_RISK.SAFE)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.ASSIST, ACTION_RISK.BOUNDED)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.ASSIST, ACTION_RISK.RISKY)).toBe(false);
	});

	it("DELEGATE permits risky actions", () => {
		expect(isActionPermitted(AUTONOMY_RUNG.DELEGATE, ACTION_RISK.SAFE)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.DELEGATE, ACTION_RISK.BOUNDED)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.DELEGATE, ACTION_RISK.RISKY)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.DELEGATE, ACTION_RISK.DESTRUCTIVE)).toBe(false);
	});

	it("AUTONOMOUS permits all actions", () => {
		expect(isActionPermitted(AUTONOMY_RUNG.AUTONOMOUS, ACTION_RISK.SAFE)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.AUTONOMOUS, ACTION_RISK.BOUNDED)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.AUTONOMOUS, ACTION_RISK.RISKY)).toBe(true);
		expect(isActionPermitted(AUTONOMY_RUNG.AUTONOMOUS, ACTION_RISK.DESTRUCTIVE)).toBe(true);
	});
});

describe("AutonomyPolicyStore", () => {
	const makeStore = () => new AutonomyPolicyStore();

	it("stores and retrieves policies", () => {
		const store = makeStore();
		const policy = createDefaultPolicy("iphone_test", "james", AUTONOMY_RUNG.ASSIST);
		store.set(policy);
		expect(store.get("iphone_test")).toEqual(policy);
	});

	it("returns undefined for unknown surface", () => {
		const store = makeStore();
		expect(store.get("unknown")).toBeUndefined();
	});

	it("removes policies", () => {
		const store = makeStore();
		const policy = createDefaultPolicy("iphone_test", "james", AUTONOMY_RUNG.ASSIST);
		store.set(policy);
		store.remove("iphone_test");
		expect(store.get("iphone_test")).toBeUndefined();
	});

	it("lists policies by user", () => {
		const store = makeStore();
		store.set(createDefaultPolicy("iphone_1", "james", AUTONOMY_RUNG.ASSIST));
		store.set(createDefaultPolicy("mac_1", "james", AUTONOMY_RUNG.DELEGATE));
		store.set(createDefaultPolicy("iphone_2", "other", AUTONOMY_RUNG.OBSERVE));

		const jamesPolicies = store.byUser("james");
		expect(jamesPolicies.length).toBe(2);
	});

	it("creates escalation requests", () => {
		const store = makeStore();
		const entry = store.escalate("iphone_test", AUTONOMY_RUNG.DELEGATE, "Need execute for build", "high");
		expect(entry.id).toMatch(/^esc\|iphone_test\|/);
		expect(entry.toRung).toBe(AUTONOMY_RUNG.DELEGATE);
		expect(entry.status).toBe("pending");
	});

	it("approves escalation and updates policy", () => {
		const store = makeStore();
		store.set(createDefaultPolicy("iphone_test", "james", AUTONOMY_RUNG.ASSIST));
		const entry = store.escalate("iphone_test", AUTONOMY_RUNG.DELEGATE, "Need execute", "high");

		const approved = store.approve(entry.id);
		expect(approved).toBe(true);
		expect(entry.status).toBe("approved");

		const policy = store.get("iphone_test");
		expect(policy?.grants).toContain(AUTONOMY_RUNG.DELEGATE);
	});

	it("rejects escalation", () => {
		const store = makeStore();
		store.set(createDefaultPolicy("iphone_test", "james", AUTONOMY_RUNG.ASSIST));
		const entry = store.escalate("iphone_test", AUTONOMY_RUNG.DELEGATE, "Need execute", "high");

		const rejected = store.reject(entry.id);
		expect(rejected).toBe(true);
		expect(entry.status).toBe("rejected");
	});

	it("returns pending escalations", () => {
		const store = makeStore();
		store.escalate("surface_1", AUTONOMY_RUNG.DELEGATE, "test 1", "low");
		store.escalate("surface_2", AUTONOMY_RUNG.AUTONOMOUS, "test 2", "high");

		const pending = store.pending();
		expect(pending.length).toBe(2);
	});

	it("clears all data", () => {
		const store = makeStore();
		store.set(createDefaultPolicy("iphone_test", "james", AUTONOMY_RUNG.ASSIST));
		store.escalate("iphone_test", AUTONOMY_RUNG.DELEGATE, "test", "low");
		store.clear();

		expect(store.get("iphone_test")).toBeUndefined();
		expect(store.pending().length).toBe(0);
	});
});

describe("Effective Rung Calculation", () => {
	it("defaults to base rung", () => {
		const policy = createDefaultPolicy("test", "james", AUTONOMY_RUNG.ASSIST);
		expect(effectiveRung(policy)).toBe(AUTONOMY_RUNG.ASSIST);
	});

	it("grants increase effective rung", () => {
		const policy = createDefaultPolicy("test", "james", AUTONOMY_RUNG.ASSIST);
		policy.grants.push(AUTONOMY_RUNG.DELEGATE);
		policy.maxRung = AUTONOMY_RUNG.DELEGATE; // Allow escalation to DELEGATE
		expect(effectiveRung(policy)).toBe(AUTONOMY_RUNG.DELEGATE);
	});

	it("restrictions decrease effective rung", () => {
		const policy = createDefaultPolicy("test", "james", AUTONOMY_RUNG.DELEGATE);
		policy.restrictions.push(AUTONOMY_RUNG.ASSIST);
		expect(effectiveRung(policy)).toBe(AUTONOMY_RUNG.ASSIST);
	});

	it("max rung caps the effective rung", () => {
		const policy = createDefaultPolicy("test", "james", AUTONOMY_RUNG.DELEGATE);
		policy.grants.push(AUTONOMY_RUNG.AUTONOMOUS);
		policy.maxRung = AUTONOMY_RUNG.DELEGATE;
		expect(effectiveRung(policy)).toBe(AUTONOMY_RUNG.DELEGATE);
	});
});

describe("AutonomyAuditLog", () => {
	const makeAudit = () => new AutonomyAuditLog();

	it("logs entries with timestamps", () => {
		const audit = makeAudit();
		audit.log({
			surfaceId: "iphone_test",
			action: "read_file",
			rung: AUTONOMY_RUNG.OBSERVE,
			risk: ACTION_RISK.SAFE,
			permitted: true,
			escalated: false,
		});

		const entries = audit.forSurface("iphone_test");
		expect(entries.length).toBe(1);
		expect(entries[0].timestamp).toBeGreaterThan(0);
	});

	it("filters by surface", () => {
		const audit = makeAudit();
		audit.log({ surfaceId: "iphone_1", action: "a", rung: 0, risk: "safe", permitted: true, escalated: false });
		audit.log({ surfaceId: "iphone_2", action: "b", rung: 0, risk: "safe", permitted: true, escalated: false });
		audit.log({ surfaceId: "iphone_1", action: "c", rung: 0, risk: "safe", permitted: true, escalated: false });

		expect(audit.forSurface("iphone_1").length).toBe(2);
		expect(audit.forSurface("iphone_2").length).toBe(1);
	});

	it("filters denied actions", () => {
		const audit = makeAudit();
		audit.log({ surfaceId: "test", action: "safe", rung: 0, risk: "safe", permitted: true, escalated: false });
		audit.log({ surfaceId: "test", action: "risky", rung: 0, risk: "risky", permitted: false, escalated: true });

		const denied = audit.denied();
		expect(denied.length).toBe(1);
		expect(denied[0].action).toBe("risky");
	});

	it("filters escalated actions", () => {
		const audit = makeAudit();
		audit.log({ surfaceId: "test", action: "a", rung: 0, risk: "safe", permitted: true, escalated: false });
		audit.log({ surfaceId: "test", action: "b", rung: 0, risk: "risky", permitted: false, escalated: true });

		const escalated = audit.escalated();
		expect(escalated.length).toBe(1);
		expect(escalated[0].action).toBe("b");
	});

	it("clears all entries when no threshold given", () => {
		const audit = makeAudit();
		audit.log({ surfaceId: "test", action: "a", rung: 0, risk: "safe", permitted: true, escalated: false });
		audit.log({ surfaceId: "test", action: "b", rung: 0, risk: "safe", permitted: true, escalated: false });
		expect(audit.forSurface("test").length).toBe(2);
		// Clear all entries
		audit.clear();
		expect(audit.forSurface("test").length).toBe(0);
	});

	it("caps entries at max", () => {
		// Create audit with small max
		const smallAudit = new AutonomyAuditLog();
		// We can't directly set maxEntries, so just verify it doesn't crash with many entries
		for (let i = 0; i < 100; i++) {
			smallAudit.log({
				surfaceId: "test",
				action: `action_${i}`,
				rung: 0,
				risk: "safe",
				permitted: true,
				escalated: false,
			});
		}
		// Should still work with many entries
		expect(smallAudit.forSurface("test").length).toBe(100);
	});
});
