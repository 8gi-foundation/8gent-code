/**
 * Slide text obeys the house rules, whatever the model emits.
 *
 * BRAND.md bans em dashes outright and these local models produce them
 * constantly. One reached a real slide heading on 2026-08-06 - "The value is in
 * the friction[em dash]seeing the messy collis..." - which broke a hard rule in
 * the most visible place the system has, a poster-sized card on a stage James
 * was watching. Prompting against it does not hold across eight models; every
 * slide field passes through clip(), so that is where it is enforced.
 *
 * The same heading was also cut mid-word, because the old truncation fell back
 * to a hard slice whenever the last space sat before 60% of the cap. A heading
 * that stops mid-word reads as broken rather than abbreviated.
 */

import { describe, expect, it } from "bun:test";
import { LIMITS, clip, normalisePunctuation } from "../slide-spec";

describe("slide punctuation", () => {
	it("replaces the em dash a model actually emitted on a live slide", () => {
		const real = "The value is in the friction—seeing the messy collision of priorities";
		const out = clip(real, LIMITS.heading);
		expect(out).not.toContain("—");
		expect(out).not.toContain("–");
		expect(out).toContain(" - ");
	});

	it("normalises en dashes and leaves the ellipsis character alone", () => {
		expect(normalisePunctuation("a–b")).toBe("a - b");
		// The ellipsis character is deliberately untouched - clip() uses it as
		// its own truncation marker, so rewriting it broke idempotency.
		expect(normalisePunctuation("wait…")).toBe("wait…");
		// Whitespace around a dash is absorbed rather than doubled.
		expect(normalisePunctuation("a — b")).toBe("a - b");
	});

	it("leaves ordinary text completely alone", () => {
		expect(clip("Friction vs. Stakes", LIMITS.heading)).toBe("Friction vs. Stakes");
		expect(normalisePunctuation("no dashes here")).toBe("no dashes here");
	});
});

describe("slide truncation", () => {
	it("never cuts mid-word when a boundary exists", () => {
		const real = "The value is in the friction, seeing the messy collision of priorities";
		const out = clip(real, LIMITS.heading);
		expect(out.endsWith("…")).toBe(true);
		// The character before the ellipsis must end a whole word: the source
		// text continues past the cut, so the last kept token must appear in the
		// original followed by a space or punctuation.
		const kept = out.slice(0, -1).trimEnd();
		const lastWord = kept.split(" ").at(-1) ?? "";
		expect(real).toContain(`${lastWord} `);
	});

	it("still cuts a single unbroken token, since it has no boundary", () => {
		const out = clip("A".repeat(200), 20);
		expect(out.length).toBeLessThanOrEqual(20);
		expect(out.endsWith("…")).toBe(true);
	});

	it("is idempotent - clipping an already-clipped string changes nothing", () => {
		// Guards against a doubled ellipsis when a field is normalised twice.
		const once = clip("some fairly long heading text that will certainly be cut", 30);
		expect(clip(once, 30)).toBe(once);
	});
});
