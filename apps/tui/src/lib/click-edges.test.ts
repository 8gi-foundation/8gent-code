/**
 * Edge clicks (James, 2026-10-02): a click anywhere on a target's drawn
 * cells, brackets and padding included, must land on it, and the cells
 * between two targets belong to one of them, never to nobody and never to
 * both. Wide characters take two cells.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { APPROVAL_KEYS } from "../components/InlineApprovalPrompt.js";
import { keyCapSpans } from "../components/KeyCap.js";
import { cellSpans } from "../components/TabBar.js";
import { type ClickSpan, clearTargets, closeGaps, hitTest, placeSpans } from "./click-targets.js";

const noop = () => {};
const span = (id: string, dx: number, w: number): ClickSpan => ({ id, dx, w, action: noop });

/** Register spans the way useClickSpans does, in a box at (x, y) of width boxW. */
function register(spans: ClickSpan[], x = 0, y = 0, boxW = 200, z = 0) {
	placeSpans({ x, y, w: boxW, h: 1 }, spans, z);
}

const at = (x: number, y = 0) => hitTest(x, y)?.id ?? null;

afterEach(() => clearTargets());

describe("closeGaps", () => {
	test("splits a gap between neighbours: left takes the floor, right the ceiling", () => {
		const out = closeGaps([span("a", 0, 4), span("b", 7, 4)]);
		expect(out.map((s) => [s.id, s.dx, s.w])).toEqual([
			["a", 0, 5],
			["b", 5, 6],
		]);
	});

	test("never overlaps: an overlapping left span is trimmed to its neighbour", () => {
		const out = closeGaps([span("a", 0, 6), span("b", 4, 3)]);
		expect(out.map((s) => [s.id, s.dx, s.w])).toEqual([
			["a", 0, 4],
			["b", 4, 3],
		]);
	});

	test("leaves a wide gap alone: a non-target segment between two targets stays non-target", () => {
		const out = closeGaps([span("a", 0, 4), span("b", 12, 4)]);
		expect(out.map((s) => [s.dx, s.w])).toEqual([
			[0, 4],
			[12, 4],
		]);
	});

	test("spans on different rows are not joined", () => {
		const out = closeGaps([span("a", 0, 4), { ...span("b", 6, 4), dy: 1 }]);
		expect(out.map((s) => [s.dx, s.w])).toEqual([
			[0, 4],
			[6, 4],
		]);
	});
});

describe("tab bar hit test", () => {
	// "1] AI James   2] Rishi" : tab 1 is cells 0-10, gap 11-13, tab 2 from 14.
	const cells = [
		{ num: "1] ", title: "AI James", active: true },
		{ num: "2] ", title: "Rishi", active: false },
	];
	const spans = () =>
		cellSpans(cells).map((s, i) => ({ id: `tab:${i}`, dx: s.x, w: s.width, h: 2, action: noop }));

	test("first column (the number) and last column (end of title) hit the tab", () => {
		register(spans(), 0, 5);
		expect(at(0, 5)).toBe("tab:0");
		expect(at(10, 5)).toBe("tab:0");
		expect(at(14, 5)).toBe("tab:1");
		expect(at(21, 5)).toBe("tab:1");
	});

	test("the three-cell gap is shared: 11 goes left, 12-13 go right, no dead cell", () => {
		register(spans(), 0, 5);
		expect(at(11, 5)).toBe("tab:0");
		expect(at(12, 5)).toBe("tab:1");
		expect(at(13, 5)).toBe("tab:1");
	});

	test("the underline row under a tab is part of it", () => {
		register(spans(), 0, 5);
		expect(at(3, 6)).toBe("tab:0");
		expect(at(16, 6)).toBe("tab:1");
		expect(at(3, 7)).toBeNull();
		expect(at(3, 4)).toBeNull();
	});

	test("past the last tab and before the first is nobody's", () => {
		register(spans(), 2, 5);
		expect(at(1, 5)).toBeNull();
		expect(at(23, 5)).toBe("tab:1");
		expect(at(24, 5)).toBeNull();
	});

	test("wide characters take two cells, so the edge follows what is drawn", () => {
		const wide = [
			{ num: "1] ", title: "日本語", active: true },
			{ num: "2] ", title: "QA", active: false },
		];
		const s = cellSpans(wide);
		expect(s[0]).toEqual({ x: 0, width: 9 });
		expect(s[1]).toEqual({ x: 12, width: 5 });
		register(s.map((c, i) => span(`tab:${i}`, c.x, c.width)));
		expect(at(8)).toBe("tab:0"); // last cell of the third wide glyph
		expect(at(9)).toBe("tab:0"); // gap, left half
		expect(at(10)).toBe("tab:1"); // gap, right half
		expect(at(16)).toBe("tab:1");
		expect(at(17)).toBeNull();
	});

	test("emoji titles are measured the way Ink draws them, so later tabs keep their edges", () => {
		// "1] 🚀 ship   2] 👨‍👩‍👧 fam   3] QA": the rocket is two cells, the
		// ZWJ family is one two-cell glyph (8SO T4 review: cellWidth said 6 and 10).
		const emoji = [
			{ num: "1] ", title: "🚀 ship", active: true },
			{ num: "2] ", title: "👨‍👩‍👧 fam", active: false },
			{ num: "3] ", title: "QA", active: false },
		];
		const s = cellSpans(emoji);
		expect(s).toEqual([
			{ x: 0, width: 10 },
			{ x: 13, width: 9 },
			{ x: 25, width: 5 },
		]);
		register(s.map((c, i) => span(`tab:${i}`, c.x, c.width)));
		expect(at(9)).toBe("tab:0"); // the "p" of "ship"
		expect(at(13)).toBe("tab:1"); // "2" of the second tab
		expect(at(25)).toBe("tab:2"); // "3" of the third tab
		expect(at(29)).toBe("tab:2"); // the "A" of "QA"
		expect(at(30)).toBeNull();
	});
});

describe("key cap row hit test", () => {
	// "[^P] palette  [^X] plan" : cap 1 is 0-11, gap 12-13, cap 2 is 14-22.
	const caps = [
		{ cap: "^P", verb: "palette" },
		{ cap: "^X", verb: "plan" },
	];

	test("the opening and closing brackets are part of the cap", () => {
		register(keyCapSpans(caps, "row", noop));
		expect(at(0)).toBe("row:^P"); // "["
		expect(at(3)).toBe("row:^P"); // "]"
		expect(at(11)).toBe("row:^P"); // last letter of "palette"
		expect(at(14)).toBe("row:^X"); // "[" of the second cap
		expect(at(22)).toBe("row:^X");
		expect(at(23)).toBeNull();
	});

	test("the two-cell gap splits one each way", () => {
		register(keyCapSpans(caps, "row", noop));
		expect(at(12)).toBe("row:^P");
		expect(at(13)).toBe("row:^X");
	});

	test("a wide glyph in a cap is counted in cells, not code units", () => {
		const s = keyCapSpans(
			[
				{ cap: "^Y", verb: "日本" },
				{ cap: "^P", verb: "go" },
			],
			"w",
			noop,
		);
		// "[^Y] 日本" is 4 + 1 + 4 = 9 cells; the second cap starts after a 2-cell gap.
		expect(s.map((x) => [x.dx, x.w])).toEqual([
			[0, 9],
			[11, 7],
		]);
	});
});

describe("approval card row (shared gap 0)", () => {
	const card = () =>
		keyCapSpans(
			APPROVAL_KEYS.map(([cap, verb]) => ({ cap, verb })),
			"card",
			noop,
		);

	test("closeGaps with maxGap 0 leaves every span as drawn", () => {
		const spans = card();
		expect(closeGaps(spans, 0).map((s) => [s.dx, s.w])).toEqual(spans.map((s) => [s.dx, s.w]));
	});

	test("gap cells 11, 12, 21, 22, 31 and 32 hit nothing; the caps keep their edges", () => {
		placeSpans({ x: 0, y: 0, w: 200, h: 1 }, card(), 10, 0);
		for (const x of [11, 12, 21, 22, 31, 32]) expect(at(x)).toBeNull();
		expect([at(0), at(10), at(13), at(20), at(23), at(30), at(33), at(40), at(41)]).toEqual([
			"card:Y",
			"card:Y",
			"card:N",
			"card:N",
			"card:E",
			"card:E",
			"card:S",
			"card:S",
			null,
		]);
	});
});

describe("placeSpans", () => {
	test("a span is clipped to its box: a truncated row never claims cells it did not draw", () => {
		register([span("a", 0, 4), span("b", 6, 10)], 0, 0, 10);
		expect(at(9)).toBe("b");
		expect(at(10)).toBeNull();
	});

	test("a span wholly outside its box registers nothing", () => {
		register([span("a", 0, 4), span("b", 12, 4)], 0, 0, 10);
		expect(at(13)).toBeNull();
	});
});
