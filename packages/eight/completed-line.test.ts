import { describe, expect, test } from "bun:test";
import { fixCompletedLine } from "./completed-line";

describe("COMPLETED line gate (#4713)", () => {
	test("trims the joke tail to the first sentence plus the state word", () => {
		const out = fixCompletedLine(
			"COMPLETED: Slug trims its own boundaries now. Two hyphens cut, suite green, commit e3d83c3. Perfection is when the string stops trying to be something else.",
		);
		expect(out.trimmed).toBe(true);
		expect(out.text).toBe("COMPLETED: Slug trims its own boundaries now. done.");
	});

	test("leaves a conforming line untouched", () => {
		const reply = "Work done.\n🎯 COMPLETED: Issue draft written. pushed.\nNext: review it.";
		const out = fixCompletedLine(reply);
		expect(out.trimmed).toBe(false);
		expect(out.text).toBe(reply);
	});

	test("keeps the model's own state word and strips quotes", () => {
		const out = fixCompletedLine('🎯 COMPLETED: Fixed "auth" bug. deployed. Why did the dev quit?');
		expect(out.text).toBe("🎯 COMPLETED: Fixed auth bug. deployed.");
	});

	test("cuts to under 25 words and never adds any", () => {
		const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
		const out = fixCompletedLine(`COMPLETED: ${long}. failed.`);
		const body = out.text.replace("COMPLETED: ", "");
		expect(body.split(/\s+/).length).toBeLessThan(25);
		expect(body.endsWith(" failed.")).toBe(true);
	});

	test("a reply with no COMPLETED line is returned as is", () => {
		expect(fixCompletedLine("All good.")).toEqual({ text: "All good.", trimmed: false });
	});

	test("a blockquote COMPLETED line is gated too", () => {
		const out = fixCompletedLine("> COMPLETED: Draft written. pushed. Ha ha.");
		expect(out.text).toBe("> COMPLETED: Draft written. pushed.");
	});

	test("a block keeps its reason and is never turned into done", () => {
		const out = fixCompletedLine("COMPLETED: Blocked. Deploy failing on key. Needs you.");
		expect(out.text).toBe("COMPLETED: Blocked. Deploy failing on key. blocked.");
		expect(fixCompletedLine("COMPLETED: Failed. Suite red on three tests. Sorry.").text).toBe(
			"COMPLETED: Failed. Suite red on three tests. failed.",
		);
	});

	test("a bold COMPLETED line is gated too", () => {
		expect(fixCompletedLine("**COMPLETED:** Draft written. pushed. Ha ha.").text).toBe(
			"**COMPLETED:** Draft written. pushed.",
		);
	});

	test("case, leading symbols and fullwidth letters", () => {
		expect(fixCompletedLine("✅ 🎯 Completed: Draft written. pushed. Ha ha.").text).toBe(
			"✅ 🎯 Completed: Draft written. pushed.",
		);
		expect(fixCompletedLine("COMPLETED: \uFF22locked. Deploy failing. Sorry.").text).toBe(
			"COMPLETED: Blocked. Deploy failing. blocked.",
		);
	});

	test("a bare state word is not repeated", () => {
		expect(fixCompletedLine("COMPLETED: blocked.\nNext: ask.").text).toBe(
			"COMPLETED: blocked.\nNext: ask.",
		);
	});
});
