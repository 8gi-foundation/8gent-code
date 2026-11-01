import { describe, expect, test } from "bun:test";
import { loadPolicies, parseDefaultPolicies } from "./policy-engine";

describe("built-in default policies are mandatory", () => {
	test("the shipped defaults load and are immutable", () => {
		const rules = loadPolicies();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.some((r) => r.immutable)).toBe(true);
	});
	test("missing or empty defaults refuse to start", () => {
		expect(() => parseDefaultPolicies("")).toThrow(/Refusing to start/);
		expect(() => parseDefaultPolicies("   \n")).toThrow(/Refusing to start/);
	});
	test("defaults with no policies refuse to start", () => {
		expect(() => parseDefaultPolicies("policies: []")).toThrow(/no policies/);
		expect(() => parseDefaultPolicies("nope: 1")).toThrow(/Refusing to start/);
	});
	test("invalid YAML refuses to start", () => {
		expect(() => parseDefaultPolicies("policies: [unclosed")).toThrow(/not valid YAML/);
	});
});
