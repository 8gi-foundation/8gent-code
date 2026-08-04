/**
 * Officer roster + @mention resolver (packages/table/officers.ts).
 *
 * Asserts the roster is complete, every officer is pinned to a LOCAL backend
 * with the correct per-provider baseUrl convention, the four backends carry
 * two officers each, and the @mention resolver accepts code/name in any case
 * with or without a leading "@".
 */

import { describe, expect, it } from "bun:test";
import { OFFICERS, listOfficers, resolveOfficer } from "../officers";

const LOCAL_PROVIDERS = new Set(["apfel", "ollama", "lmstudio"]);

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

	it("distributes two officers to each of the four live backends", () => {
		// Backend identity = provider + model (lmstudio hosts two models).
		const counts = new Map<string, number>();
		for (const officer of listOfficers()) {
			const key = `${officer.provider}:${officer.model}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		expect([...counts.values()].sort()).toEqual([2, 2, 2, 2]);
		expect(counts.get("apfel:apple-foundationmodel")).toBe(2);
		expect(counts.get("ollama:llama3.2:3b")).toBe(2);
		expect(counts.get("lmstudio:ornith-1.0-9b")).toBe(2);
		expect(counts.get("lmstudio:gemma-4-12b-coder-fable5-composer2.5-v1")).toBe(2);
	});

	it("uses the correct baseUrl convention per provider", () => {
		// apfel base carries /v1 (client appends /chat/completions).
		expect(OFFICERS["8EO"].baseUrl).toBe("http://127.0.0.1:11435/v1");
		// lmstudio base has NO /v1 (client appends /v1/chat/completions).
		expect(OFFICERS["8TO"].baseUrl).toBe("http://127.0.0.1:1234");
		expect(OFFICERS["8TO"].baseUrl).not.toContain("/v1");
		// ollama base is host only (client appends /api/chat).
		expect(OFFICERS["8CO"].baseUrl).toBe("http://127.0.0.1:11434");
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
