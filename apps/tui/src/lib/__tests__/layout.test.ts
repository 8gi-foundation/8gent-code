/**
 * popupLayout / centerColumnWidth (issue #2913).
 *
 * The slash autocomplete box and the Ctrl+P palette must fit the centre
 * column of the V2 shell at the two sizes the issue was reproduced at:
 * 120x40 (all rails) and 100x30 (activity rail only).
 */

import { describe, expect, test } from "bun:test";
import { SHELL_CHROME, centerColumnWidth, popupLayout } from "../layout";

describe("centerColumnWidth", () => {
	test("120 columns with both rails leaves the measured 27-column centre", () => {
		// From the live frame: centre content spans columns 58..84.
		expect(centerColumnWidth(120, { contextRail: true, activityRail: true })).toBe(27);
	});

	test("100 columns (activity rail only) leaves 61 columns", () => {
		expect(centerColumnWidth(100, { contextRail: false, activityRail: true })).toBe(61);
	});

	test("80 columns (no rails) leaves the frame width", () => {
		expect(centerColumnWidth(80, { contextRail: false, activityRail: false })).toBe(
			80 - SHELL_CHROME.frameCols,
		);
	});

	test("never returns less than the minimum", () => {
		expect(centerColumnWidth(30, { contextRail: true, activityRail: true })).toBe(20);
	});
});

describe("popupLayout", () => {
	test("120x40: full row budgets, 27-column popups", () => {
		const l = popupLayout({ width: 120, height: 40 }, { contextRail: true, activityRail: true });
		expect(l).toEqual({ width: 27, slashRows: 14, paletteRows: 10 });
	});

	test("100x30: rows shrink so the boxes stay inside the main frame", () => {
		const l = popupLayout({ width: 100, height: 30 }, { contextRail: false, activityRail: true });
		expect(l.width).toBe(61);
		// 30 rows - 19 fixed - 1 safety (header wraps below ~110 cols) = 10
		// free. Slash box needs 5 rows of chrome, palette 7, so 5 and 3
		// entries respectively. Verified live: 6 and 4 put the popup's
		// bottom border on top of the main frame's.
		expect(l.slashRows).toBe(5);
		expect(l.paletteRows).toBe(3);
		const free = 30 - SHELL_CHROME.fixedRows - SHELL_CHROME.safetyRows;
		expect(l.slashRows + 5).toBeLessThanOrEqual(free);
		expect(l.paletteRows + 7).toBeLessThanOrEqual(free);
	});

	test("tiny terminals still get at least three rows", () => {
		const l = popupLayout({ width: 60, height: 20 }, { contextRail: false, activityRail: false });
		expect(l.slashRows).toBe(3);
		expect(l.paletteRows).toBe(3);
	});
});
