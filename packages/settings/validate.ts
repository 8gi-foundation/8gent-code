/**
 * 8gent Code - Settings Validation
 *
 * Pure validators for values a user types into a settings editor. The TUI
 * Settings view runs these before committing an edit so invalid input is
 * rejected with a message that names the rule, instead of snapping back to
 * the previous value with no feedback.
 *
 * Every validator is side-effect free and returns either the normalised value
 * or a one-line message suitable for display under the field.
 */

export interface NumberRule {
	min: number;
	max: number;
	/**
	 * Reject non-integers. Defaults to true because every numeric setting today
	 * is a millisecond count.
	 */
	integer?: boolean;
}

export type TextRuleKind = "voice" | "identifier" | "url" | "nonEmpty";

export interface TextRule {
	kind: TextRuleKind;
	/** Human noun used in the message, e.g. "provider name". */
	what?: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Clamp `value` into [min, max]. NaN collapses to `min`. */
export function clampNumber(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) return min;
	return Math.max(min, Math.min(max, value));
}

/** The one-line rule shown when a number is rejected. */
export function numberRuleMessage(rule: NumberRule): string {
	const noun = (rule.integer ?? true) ? "a whole number" : "a number";
	return `Enter ${noun} between ${rule.min} and ${rule.max}`;
}

/** The one-line rule shown when a text value is rejected. */
export function textRuleMessage(rule: TextRule): string {
	switch (rule.kind) {
		case "voice":
			return "Enter a macOS voice name, e.g. Ava";
		case "identifier":
			return `Enter a ${rule.what ?? "value"} with no spaces`;
		case "url":
			return "Enter a URL starting with http:// or https://";
		case "nonEmpty":
			return `Enter a ${rule.what ?? "value"}`;
	}
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Validate a typed number against its range. Accepts surrounding whitespace,
 * rejects anything that is not a plain decimal literal, and never clamps: a
 * value outside the range is an error the user should see.
 */
export function validateNumber(raw: string, rule: NumberRule): ValidationResult<number> {
	const trimmed = raw.trim();
	const message = numberRuleMessage(rule);
	if (trimmed === "" || !NUMERIC.test(trimmed)) return { ok: false, message };
	const value = Number(trimmed);
	if (!Number.isFinite(value)) return { ok: false, message };
	if ((rule.integer ?? true) && !Number.isInteger(value)) return { ok: false, message };
	if (value < rule.min || value > rule.max) return { ok: false, message };
	return { ok: true, value };
}

/**
 * Validate a typed string. The returned value is trimmed so stray spaces at
 * either end never reach the settings file.
 */
export function validateText(raw: string, rule: TextRule): ValidationResult<string> {
	const trimmed = raw.trim();
	const message = textRuleMessage(rule);
	if (trimmed === "") return { ok: false, message };
	switch (rule.kind) {
		case "voice":
		case "nonEmpty":
			return { ok: true, value: trimmed };
		case "identifier":
			if (/\s/.test(trimmed)) return { ok: false, message };
			return { ok: true, value: trimmed };
		case "url": {
			let parsed: URL;
			try {
				parsed = new URL(trimmed);
			} catch {
				return { ok: false, message };
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return { ok: false, message };
			}
			return { ok: true, value: trimmed };
		}
	}
}
