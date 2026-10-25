import { describe, expect, test } from "bun:test";
import { mayOfferSend } from "./vessel-proposal-send-gate.js";

describe("mayOfferSend", () => {
	test("unattended is always false, even with matching confirmation", () => {
		expect(mayOfferSend({ unattended: true, shownText: "a", confirmedText: "a" })).toBe(false);
	});

	test("null confirmation is false", () => {
		expect(mayOfferSend({ unattended: false, shownText: "a", confirmedText: null })).toBe(false);
	});

	test("mismatched text is false", () => {
		expect(mayOfferSend({ unattended: false, shownText: "a", confirmedText: "a " })).toBe(false);
	});

	test("matching interactive confirmation is true", () => {
		expect(mayOfferSend({ unattended: false, shownText: "a", confirmedText: "a" })).toBe(true);
	});

	test("missing unattended is false (fail closed)", () => {
		const input = { shownText: "a", confirmedText: "a" } as unknown as Parameters<
			typeof mayOfferSend
		>[0];
		expect(mayOfferSend(input)).toBe(false);
	});

	test("undefined unattended is false (fail closed)", () => {
		const input = {
			unattended: undefined,
			shownText: "a",
			confirmedText: "a",
		} as unknown as Parameters<typeof mayOfferSend>[0];
		expect(mayOfferSend(input)).toBe(false);
	});

	test("empty shownText is false even with empty confirmation", () => {
		expect(mayOfferSend({ unattended: false, shownText: "", confirmedText: "" })).toBe(false);
	});

	test("empty confirmedText against real shownText is false", () => {
		expect(mayOfferSend({ unattended: false, shownText: "a", confirmedText: "" })).toBe(false);
	});

	test("undefined confirmedText is false", () => {
		const input = {
			unattended: false,
			shownText: "a",
			confirmedText: undefined,
		} as unknown as Parameters<typeof mayOfferSend>[0];
		expect(mayOfferSend(input)).toBe(false);
	});
});
