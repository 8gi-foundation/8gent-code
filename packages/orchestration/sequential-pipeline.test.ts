/**
 * Validate-stage verdict parsing (SPEC-05 #108). The structured verdict backs
 * the fragile REJECTED substring heuristic when JSON mode is available.
 */

import { describe, expect, test } from "bun:test";
import { parseStructuredVerdict } from "./sequential-pipeline";

describe("parseStructuredVerdict", () => {
	test("parses an approved verdict from a JSON object", () => {
		expect(parseStructuredVerdict('reasoning...\n{"verdict":"APPROVED"}')).toBe(true);
	});

	test("parses a rejected verdict from a JSON object", () => {
		expect(parseStructuredVerdict('{"verdict":"REJECTED"}\ntrailing prose')).toBe(false);
	});

	test("parses a boolean approved field", () => {
		expect(parseStructuredVerdict('{"approved": false}')).toBe(false);
		expect(parseStructuredVerdict('{"approved": true}')).toBe(true);
	});

	test("prefers the last JSON verdict when the model restates it", () => {
		expect(parseStructuredVerdict('{"verdict":"REJECTED"} ... {"verdict":"APPROVED"}')).toBe(true);
	});

	test("returns null when no structured verdict is present", () => {
		expect(parseStructuredVerdict("VERDICT: APPROVED\nFLAWS: none")).toBeNull();
	});

	test("skips malformed JSON without throwing", () => {
		expect(parseStructuredVerdict('{"verdict": }')).toBeNull();
	});
});
