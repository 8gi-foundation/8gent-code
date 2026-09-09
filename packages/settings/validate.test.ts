/**
 * Settings validation tests.
 *
 * These validators back the TUI Settings view: every rejection must carry a
 * message that names the rule, and every acceptance must return a value that
 * is safe to write to ~/.8gent/settings.json.
 */

import { describe, expect, test } from "bun:test";
import {
	clampNumber,
	numberRuleMessage,
	textRuleMessage,
	validateNumber,
	validateText,
} from "./validate.js";

const SILENCE = { min: 500, max: 5000 };

describe("validateNumber", () => {
	test("accepts an in-range integer and returns it as a number", () => {
		expect(validateNumber("2000", SILENCE)).toEqual({ ok: true, value: 2000 });
	});

	test("accepts the range bounds", () => {
		expect(validateNumber("500", SILENCE)).toEqual({ ok: true, value: 500 });
		expect(validateNumber("5000", SILENCE)).toEqual({ ok: true, value: 5000 });
	});

	test("tolerates surrounding whitespace", () => {
		expect(validateNumber("  1500 ", SILENCE)).toEqual({ ok: true, value: 1500 });
	});

	test("rejects letters with the range message", () => {
		const result = validateNumber("abc", SILENCE);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toBe("Enter a whole number between 500 and 5000");
	});

	test("rejects a mixed string like 2000abc", () => {
		expect(validateNumber("2000abc", SILENCE).ok).toBe(false);
	});

	test("rejects an empty buffer", () => {
		expect(validateNumber("", SILENCE).ok).toBe(false);
		expect(validateNumber("   ", SILENCE).ok).toBe(false);
	});

	test("rejects out-of-range values instead of clamping", () => {
		expect(validateNumber("499", SILENCE).ok).toBe(false);
		expect(validateNumber("5001", SILENCE).ok).toBe(false);
		expect(validateNumber("-100", SILENCE).ok).toBe(false);
	});

	test("rejects decimals when the rule is integer (default)", () => {
		expect(validateNumber("1500.5", SILENCE).ok).toBe(false);
	});

	test("accepts decimals when integer is false", () => {
		expect(validateNumber("1500.5", { ...SILENCE, integer: false })).toEqual({
			ok: true,
			value: 1500.5,
		});
	});

	test("rejects Infinity and NaN literals", () => {
		expect(validateNumber("Infinity", SILENCE).ok).toBe(false);
		expect(validateNumber("NaN", SILENCE).ok).toBe(false);
	});
});

describe("numberRuleMessage", () => {
	test("names the range", () => {
		expect(numberRuleMessage({ min: 1000, max: 60000 })).toBe(
			"Enter a whole number between 1000 and 60000",
		);
	});

	test("drops the whole-number wording when decimals are allowed", () => {
		expect(numberRuleMessage({ min: 0, max: 1, integer: false })).toBe(
			"Enter a number between 0 and 1",
		);
	});
});

describe("validateText", () => {
	test("voice: accepts a name and trims it", () => {
		expect(validateText("  Ava ", { kind: "voice" })).toEqual({ ok: true, value: "Ava" });
	});

	test("voice: accepts multi-word macOS voice names", () => {
		expect(validateText("Ava (Premium)", { kind: "voice" })).toEqual({
			ok: true,
			value: "Ava (Premium)",
		});
	});

	test("voice: rejects empty with an example", () => {
		const result = validateText("", { kind: "voice" });
		expect(result).toEqual({ ok: false, message: "Enter a macOS voice name, e.g. Ava" });
	});

	test("identifier: accepts a model id with slashes and colons", () => {
		expect(
			validateText("google/gemma-4-26b-a4b", { kind: "identifier", what: "model id" }),
		).toEqual({ ok: true, value: "google/gemma-4-26b-a4b" });
		expect(validateText("qwen3.6:27b", { kind: "identifier", what: "model id" })).toEqual({
			ok: true,
			value: "qwen3.6:27b",
		});
	});

	test("identifier: rejects inner whitespace and names the noun", () => {
		const result = validateText("my provider", { kind: "identifier", what: "provider name" });
		expect(result).toEqual({ ok: false, message: "Enter a provider name with no spaces" });
	});

	test("identifier: rejects empty", () => {
		expect(validateText("   ", { kind: "identifier", what: "provider name" }).ok).toBe(false);
	});

	test("url: accepts http and https endpoints", () => {
		expect(validateText("http://localhost:11434/v1", { kind: "url" })).toEqual({
			ok: true,
			value: "http://localhost:11434/v1",
		});
		expect(validateText("https://openrouter.ai/api/v1", { kind: "url" })).toEqual({
			ok: true,
			value: "https://openrouter.ai/api/v1",
		});
	});

	test("url: rejects a bare host, a non-http scheme, and garbage", () => {
		const message = "Enter a URL starting with http:// or https://";
		expect(validateText("localhost:11434", { kind: "url" })).toEqual({ ok: false, message });
		expect(validateText("ftp://example.com", { kind: "url" })).toEqual({ ok: false, message });
		expect(validateText("not a url", { kind: "url" })).toEqual({ ok: false, message });
		expect(validateText("", { kind: "url" })).toEqual({ ok: false, message });
	});

	test("nonEmpty: accepts any trimmed text and rejects blanks", () => {
		expect(validateText(" amber ", { kind: "nonEmpty", what: "theme name" })).toEqual({
			ok: true,
			value: "amber",
		});
		expect(validateText("", { kind: "nonEmpty", what: "theme name" })).toEqual({
			ok: false,
			message: "Enter a theme name",
		});
	});
});

describe("textRuleMessage", () => {
	test("falls back to a generic noun", () => {
		expect(textRuleMessage({ kind: "identifier" })).toBe("Enter a value with no spaces");
		expect(textRuleMessage({ kind: "nonEmpty" })).toBe("Enter a value");
	});
});

describe("clampNumber", () => {
	test("clamps both ends and collapses NaN to min", () => {
		expect(clampNumber(10, 500, 5000)).toBe(500);
		expect(clampNumber(9000, 500, 5000)).toBe(5000);
		expect(clampNumber(2000, 500, 5000)).toBe(2000);
		expect(clampNumber(Number.NaN, 500, 5000)).toBe(500);
	});
});
