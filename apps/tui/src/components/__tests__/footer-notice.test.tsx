/**
 * A footer notice ("copied 12 chars", "live view open in 8gent Browser") takes
 * the hint slot for two seconds. The status beside it is whole or absent, never
 * cut mid-word ("mode Pl...", "session...") and the notice itself never
 * overflows the row.
 */

import { describe, expect, test } from "bun:test";
import {
	type FooterSegment,
	buildFooterSegments,
	fitFooterNotice,
	segmentsWidth,
} from "../StatusFooter.js";

const all = (): FooterSegment[] =>
	buildFooterSegments({
		mode: "Planning",
		sessionTime: "8m 12s",
		providersLive: 2,
		providersTotal: 3,
		user: "james",
	});

describe("fitFooterNotice", () => {
	test("at 100 columns every segment that fits stays, whole", () => {
		const r = fitFooterNotice(all(), 100, "copied 12 chars");
		expect(r.text).toBe("copied 12 chars");
		expect(segmentsWidth(r.segments)).toBeLessThanOrEqual(100 - r.text.length - 3);
		expect(r.segments.length).toBeGreaterThan(0);
	});

	test("at 40 columns a long notice takes the row and the status steps aside whole", () => {
		const r = fitFooterNotice(all(), 40, "live view open in 8gent Browser");
		expect(r.text).toBe("live view open in 8gent Browser");
		expect(r.segments).toEqual([]);
	});

	test("every width 30..160: what is kept fits beside the notice, with no cut", () => {
		for (let w = 30; w <= 160; w++) {
			const r = fitFooterNotice(all(), w, "motion off");
			expect(
				r.text.length + segmentsWidth(r.segments) + (r.segments.length ? 3 : 0),
			).toBeLessThanOrEqual(w);
		}
	});

	test("a notice wider than the row ends in an ellipsis instead of overflowing", () => {
		const r = fitFooterNotice(all(), 20, "live view open in 8gent Browser");
		expect(r.text.length).toBeLessThanOrEqual(19);
		expect(r.text.endsWith("…")).toBe(true);
		expect(r.segments).toEqual([]);
	});
});
