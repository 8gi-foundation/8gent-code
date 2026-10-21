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
});
