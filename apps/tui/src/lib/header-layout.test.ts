/**
 * Contract tests for the header row fitting math (#2921).
 *
 * The header at 100x30 used to wrap its workspace segment onto the line
 * above the brand pill, and at 120 columns cut the branch to three letters
 * while the path kept more room than it needed. These pin the ladder:
 * branch first, then a usable path slice, then sync, then the rest.
 */

import { describe, expect, test } from "bun:test";
import {
	BRANCH_MAX,
	PATH_MIN,
	cellWidth,
	fitHeaderMiddle,
	headerMiddleWidth,
	truncateEnd,
	truncateMiddle,
} from "./header-layout.js";

const PATH = "/Users/operator/8gent-code/.claude/worktrees/agent-a8b0f5de5b64292c6";
const BRANCH = "fix/header-rail-100-cols";
const SYNC = "up to date";

describe("cellWidth", () => {
	test("ascii and the header glyphs are one cell each", () => {
		expect(cellWidth("abc")).toBe(3);
		expect(cellWidth("⎇ ○ ● ▣ │ …")).toBe(11);
	});

	test("wide CJK characters are two cells", () => {
		expect(cellWidth("日本")).toBe(4);
	});

	test("combining marks take no cell", () => {
		expect(cellWidth("é")).toBe(1);
	});
});

describe("truncateMiddle / truncateEnd", () => {
	test("return the input untouched when it fits", () => {
		expect(truncateMiddle("short", 10)).toBe("short");
		expect(truncateEnd("short", 10)).toBe("short");
	});

	test("keep head and tail with a single ellipsis", () => {
		const out = truncateMiddle(PATH, 13);
		expect(cellWidth(out)).toBe(13);
		expect(out.startsWith("/Users")).toBe(true);
		expect(out.endsWith("292c6")).toBe(true);
		expect(out).toContain("…");
	});

	test("truncateEnd keeps the head", () => {
		expect(truncateEnd(BRANCH, 10)).toBe("fix/heade…");
		expect(cellWidth(truncateEnd(BRANCH, 10))).toBe(10);
	});

	test("degenerate widths never throw", () => {
		expect(truncateMiddle(PATH, 0)).toBe("");
		expect(truncateMiddle(PATH, 1)).toBe("…");
		expect(truncateEnd(PATH, 0)).toBe("");
		expect(truncateEnd(PATH, 1)).toBe("…");
	});
});

describe("fitHeaderMiddle", () => {
	test("keeps everything when it fits", () => {
		const m = fitHeaderMiddle("/home/op/repo", "main", SYNC, 80);
		expect(m).toEqual({ path: "/home/op/repo", branch: "main", sync: SYNC });
		expect(headerMiddleWidth(m)).toBe("/home/op/repo".length + 3 + 4 + 1 + SYNC.length);
	});

	test("cuts the path first, keeping branch and sync whole", () => {
		const avail = 3 + BRANCH.length + 1 + SYNC.length + PATH_MIN + 4;
		const m = fitHeaderMiddle(PATH, BRANCH, SYNC, avail);
		expect(m.branch).toBe(BRANCH);
		expect(m.sync).toBe(SYNC);
		expect(cellWidth(m.path)).toBe(PATH_MIN + 4);
		expect(headerMiddleWidth(m)).toBe(avail);
	});

	test("drops sync before cutting the path below PATH_MIN", () => {
		const avail = 3 + BRANCH.length + PATH_MIN;
		const m = fitHeaderMiddle(PATH, BRANCH, SYNC, avail);
		expect(m.branch).toBe(BRANCH);
		expect(m.sync).toBe("");
		expect(cellWidth(m.path)).toBe(PATH_MIN);
		expect(headerMiddleWidth(m)).toBe(avail);
	});

	test("hides the path before cutting the branch (120 column case)", () => {
		// 120 cols leaves 28 for the middle with the full status cluster.
		const m = fitHeaderMiddle(PATH, BRANCH, SYNC, 28);
		expect(m.path).toBe("");
		expect(m.branch).toBe(BRANCH);
		expect(headerMiddleWidth(m)).toBeLessThanOrEqual(28);
	});

	test("keeps sync next to a bare branch when it fits", () => {
		const m = fitHeaderMiddle(PATH, "main", SYNC, 2 + 4 + 1 + SYNC.length);
		expect(m).toEqual({ path: "", branch: "main", sync: SYNC });
	});

	test("cuts the branch tail only as a last resort (100 column case)", () => {
		// 100 cols with the compact hint leaves roughly 16 columns.
		const m = fitHeaderMiddle(PATH, BRANCH, SYNC, 16);
		expect(m.path).toBe("");
		expect(m.sync).toBe("");
		expect(m.branch).toBe("fix/header-ra…");
		expect(headerMiddleWidth(m)).toBe(16);
	});

	test("renders nothing when there is no usable room", () => {
		expect(fitHeaderMiddle(PATH, BRANCH, SYNC, 0)).toEqual({ path: "", branch: "", sync: "" });
		expect(fitHeaderMiddle(PATH, BRANCH, SYNC, 4)).toEqual({ path: "", branch: "", sync: "" });
		expect(headerMiddleWidth({ path: "", branch: "", sync: "" })).toBe(0);
	});

	test("never exceeds the available width at any size", () => {
		for (let avail = 0; avail <= 120; avail++) {
			const m = fitHeaderMiddle(PATH, BRANCH, SYNC, avail);
			expect(headerMiddleWidth(m)).toBeLessThanOrEqual(avail);
		}
	});

	test("caps an absurd branch name at BRANCH_MAX", () => {
		const long = "feature/" + "x".repeat(80);
		const m = fitHeaderMiddle("/r", long, SYNC, 200);
		expect(cellWidth(m.branch)).toBe(BRANCH_MAX);
	});
});

describe("fitHeaderMiddle without a branch (audit #10)", () => {
	test("outside a repo: the path and 'no repo', never a '⎇ -'", () => {
		const m = fitHeaderMiddle("/tmp/work", "", "no repo", 80);
		expect(m).toEqual({ path: "/tmp/work", branch: "", sync: "no repo" });
		expect(headerMiddleWidth(m)).toBe(cellWidth("/tmp/work no repo"));
	});

	test("before the first check: the path alone", () => {
		expect(fitHeaderMiddle("/tmp/work", "", "", 80)).toEqual({ path: "/tmp/work", branch: "", sync: "" });
	});

	test("tight: the path is cut in the middle, then the path goes and the note stays, never past the room", () => {
		for (let room = 0; room <= 90; room++) {
			const m = fitHeaderMiddle(PATH, "", "no repo", room);
			expect(headerMiddleWidth(m)).toBeLessThanOrEqual(room);
			expect(m.branch).toBe("");
		}
		// The note holds the branch's slot: too little room for both keeps the note.
		expect(fitHeaderMiddle(PATH, "", "no repo", PATH_MIN + 2)).toEqual({ path: "", branch: "", sync: "no repo" });
		// Before the first git check there is no note, so the path keeps the room.
		expect(fitHeaderMiddle(PATH, "", "", PATH_MIN + 2).path).not.toBe("");
	});
});
