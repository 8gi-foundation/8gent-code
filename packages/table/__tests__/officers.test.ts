/**
 * Officer roster + @mention resolver (packages/table/officers.ts).
 *
 * Asserts the roster is complete, every officer is pinned to a LOCAL backend
 * with the correct per-provider baseUrl convention, the four backends carry
 * two officers each, and the @mention resolver accepts code/name in any case
 * with or without a leading "@".
 */

import { describe, expect, it } from "bun:test";
import { OFFICERS, type HarnessKind, listOfficers, resolveOfficer } from "../officers";

const LOCAL_PROVIDERS = new Set(["apfel", "ollama", "lmstudio"]);
const VALID_HARNESS_KINDS: ReadonlySet<HarnessKind> = new Set<HarnessKind>([
	"claude",
	"codex",
	"8gent-local",
	"shell",
	"pi",
	"cursor-agent",
	"opencode",
]);

describe("table officer roster", () => {
	it("has all eight officer codes", () => {
		expect(Object.keys(OFFICERS).sort()).toEqual([
			"8CO",
			"8DO",
			"8EO",
			"8GO",
			"8MO",
			"8PO",
			"8SO",
			"8TO",
		]);
		expect(listOfficers()).toHaveLength(8);
	});

	it("pins every officer to a local backend (no cloud)", () => {
		for (const officer of listOfficers()) {
			expect(LOCAL_PROVIDERS.has(officer.provider)).toBe(true);
			expect(officer.model.length).toBeGreaterThan(0);
			expect(officer.systemPrompt.length).toBeGreaterThan(0);
			// Prohibition: no em dashes anywhere in officer copy.
			expect(officer.systemPrompt).not.toContain("—");
		}
	});

	it("spreads officers across every configured backend, none stranded", () => {
		// This asserted a tidy 2/2/2/2 spread, which was the ORIGINAL design intent.
		// Measurement superseded it: night-factory runs showed apfel and llama3.2
		// producing materially weaker answers for the product and community seats,
		// so 8PO and 8CO were deliberately moved onto gemma. Quality beat symmetry.
		// The assertion is updated to match reality rather than degrading officers
		// to satisfy a stale number.
		//
		// What still matters, and is asserted: every provider in the roster carries
		// at least one officer (nothing stranded on a backend nobody uses), and no
		// single backend holds ALL of them (which would remove every scrap of
		// cross-backend parallelism).
		//
		// Recorded so it is not rediscovered: concurrency lanes are NOT the officer
		// count, and not even the endpoint count - lmstudio and ollama both run
		// Metal on the same GPU and contend, so only apfel is a truly independent
		// substrate. See docs/8GENT-HUDDLE-SPEC.md.
		const counts = new Map<string, number>();
		for (const officer of listOfficers()) {
			const key = `${officer.provider}:${officer.model}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const total = listOfficers().length;
		expect(counts.size).toBeGreaterThanOrEqual(3);
		for (const [, n] of counts) expect(n).toBeGreaterThanOrEqual(1);
		expect(Math.max(...counts.values())).toBeLessThan(total);
		expect(new Set([...counts.keys()].map((k) => k.split(":")[0]))).toEqual(
			new Set(["apfel", "ollama", "lmstudio"]),
		);
	});

	it("gives every officer a non-empty, real EXECUTION harness kind (distinct from chat provider)", () => {
		for (const officer of listOfficers()) {
			expect(officer.harness).toBeDefined();
			expect(officer.harness.kind.length).toBeGreaterThan(0);
			expect(VALID_HARNESS_KINDS.has(officer.harness.kind)).toBe(true);
			// "goose" is deliberately excluded (broken CLI on the reference machine).
			expect(officer.harness.kind).not.toBe("goose");
		}
	});

	it("seats no officer on a harness that cannot authenticate on the reference machine", () => {
		// A binding to an unauthenticated CLI is not a soft failure - it is a desk
		// nobody can sit at, and every approved proposal for that officer dies at a
		// login gate instead of doing work. 8DO sat on cursor-agent this way until
		// 2026-08-06.
		//
		// cursor-agent remains a SUPPORTED KIND (VALID_HARNESS_KINDS still contains
		// it, helm.py still spawns it, its --model flag is still real). The
		// integration is fine; the credentials are the problem. So this asserts on
		// the ROSTER, not on the union - the day a CURSOR_API_KEY exists in the
		// worker environment, delete this test rather than weakening the union.
		//
		// Deliberately not a live probe: `cursor-agent status` lies (it prints
		// "Login successful" while real prompts return "Authentication required"),
		// so there is no cheap in-test check that would be trustworthy anyway.
		const UNAUTHENTICATED_KINDS = new Set(["cursor-agent"]);
		const stranded = listOfficers()
			.filter((o) => UNAUTHENTICATED_KINDS.has(o.harness.kind))
			.map((o) => `${o.code} -> ${o.harness.kind}`);
		expect(stranded).toEqual([]);
	});

	it("seats the design officer on a free, local harness", () => {
		// Design is the highest-iteration brief on the board, so 8DO's harness is
		// the one where per-proposal cloud billing hurts most and where leaking the
		// product surface to a vendor is least acceptable. Guard the property (free
		// + local), not the specific kind, so a future local harness can take the
		// seat without editing this assertion.
		const FREE_LOCAL_KINDS = new Set(["8gent-local", "shell"]);
		const moira = resolveOfficer("8DO");
		expect(moira).toBeDefined();
		expect(FREE_LOCAL_KINDS.has(moira!.harness.kind)).toBe(true);
	});

	it("uses the correct baseUrl convention per provider", () => {
		// The conventions differ per client and getting one wrong yields a
		// "undefined/chat/completions" style failure that is painful to trace, so
		// this invariant is worth guarding. Look officers up BY PROVIDER rather
		// than by hardcoded code: this test used to name 8CO as its ollama example
		// and broke the day 8CO was legitimately moved to lmstudio, failing for a
		// roster change that was never the thing under test.
		const byProvider = (p: string) => listOfficers().find((o) => o.provider === p);

		// apfel base carries /v1 (client appends /chat/completions).
		expect(byProvider("apfel")?.baseUrl).toBe("http://127.0.0.1:11435/v1");
		// lmstudio base has NO /v1 (client appends /v1/chat/completions).
		const lmstudio = byProvider("lmstudio");
		expect(lmstudio?.baseUrl).toBe("http://127.0.0.1:1234");
		expect(lmstudio?.baseUrl).not.toContain("/v1");
		// ollama base is host only (client appends /api/chat).
		expect(byProvider("ollama")?.baseUrl).toBe("http://127.0.0.1:11434");
	});
});

describe("resolveOfficer @mention router", () => {
	it("resolves by code, any case, with or without @", () => {
		expect(resolveOfficer("8TO")?.name).toBe("Rishi");
		expect(resolveOfficer("@8TO")?.name).toBe("Rishi");
		expect(resolveOfficer("8to")?.name).toBe("Rishi");
		expect(resolveOfficer("@8to")?.name).toBe("Rishi");
	});

	it("resolves by display name, any case, with or without @", () => {
		expect(resolveOfficer("Rishi")?.code).toBe("8TO");
		expect(resolveOfficer("@rishi")?.code).toBe("8TO");
		expect(resolveOfficer("KAREN")?.code).toBe("8SO");
		expect(resolveOfficer("solomon")?.code).toBe("8GO");
	});

	it("returns undefined for non-officers and empties", () => {
		expect(resolveOfficer("nobody")).toBeUndefined();
		expect(resolveOfficer("@")).toBeUndefined();
		expect(resolveOfficer("")).toBeUndefined();
	});
});
