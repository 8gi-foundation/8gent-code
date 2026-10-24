import { describe, expect, test } from "bun:test";
import {
	COLLAPSED_LINES,
	EXPANDED_HEAD,
	EXPANDED_TAIL,
	outputBody,
	viewOutput,
} from "./tool-output";

const lines = (n: number, p = "line") => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`);

describe("outputBody", () => {
	test("drops the Exit code header of a failed run and trailing blank lines", () => {
		expect(outputBody("Exit code 1:\nout 1\n\nerr 1\nerr 2\n\n\n", "fail")).toEqual([
			"out 1",
			"",
			"err 1",
			"err 2",
		]);
	});
	test("keeps the first line of a success", () => {
		expect(outputBody("Exit code is not special here\nrest", "ok")).toEqual([
			"Exit code is not special here",
			"rest",
		]);
	});
	test("strips terminal escapes and control characters, tabs become two spaces", () => {
		expect(outputBody("\u001b[31mred\u001b[0m\tx\u0007\u009b", "ok")).toEqual(["red  x"]);
	});
	test("empty output is no lines", () => {
		expect(outputBody("", "ok")).toEqual([]);
		expect(outputBody("Exit code 2:\n\n", "fail")).toEqual([]);
	});
	test("CRLF and bare CR split lines", () => {
		expect(outputBody("a\r\nb\rc", "ok")).toEqual(["a", "b", "c"]);
	});
});

describe("collapsed", () => {
	test("a success shows nothing until opened", () => {
		const v = viewOutput(lines(30), { status: "ok", expanded: false, width: 80, seq: 7 });
		expect(v.lines).toEqual([]);
		expect(v.hint).toBeNull();
	});
	test("a failure shows the last 10 lines (the stderr tail) and how many more", () => {
		const v = viewOutput(lines(48), { status: "fail", expanded: false, width: 80, seq: 3 });
		expect(v.lines).toEqual(lines(48).slice(-COLLAPSED_LINES));
		expect(v.hint).toBe("38 more lines (^O or tap, /out 3)");
	});
	test("a short failure shows everything and no hint", () => {
		const v = viewOutput(lines(4), { status: "fail", expanded: false, width: 80, seq: 3 });
		expect(v.lines).toEqual(lines(4));
		expect(v.hint).toBeNull();
	});
	test("exactly 10 lines needs no hint; 11 hides one", () => {
		expect(
			viewOutput(lines(10), { status: "fail", expanded: false, width: 80, seq: 1 }).hint,
		).toBeNull();
		const v = viewOutput(lines(11), { status: "fail", expanded: false, width: 80, seq: 1 });
		expect(v.lines.length).toBe(10);
		expect(v.hint).toContain("1 more");
	});
	test("a blocked call shows its reason text like a failure", () => {
		const v = viewOutput(["[no-secrets-in-files] refused"], {
			status: "blocked",
			expanded: false,
			width: 80,
			seq: 1,
		});
		expect(v.lines).toEqual(["[no-secrets-in-files] refused"]);
	});
	test("narrow screens get the short hint with the /out number", () => {
		const v = viewOutput(lines(48), { status: "fail", expanded: false, width: 40, seq: 3 });
		expect(v.hint).toBe("38 more  /out 3");
	});
});

describe("expanded", () => {
	test("up to 50 lines show in full and the hint says how to close", () => {
		const v = viewOutput(lines(50), { status: "ok", expanded: true, width: 80, seq: 2 });
		expect(v.lines).toEqual(lines(50));
		expect(v.hint).toBe("^O or tap to collapse");
	});
	test("more than 50: first 40, a marker, last 10", () => {
		const all = lines(200);
		const v = viewOutput(all, { status: "ok", expanded: true, width: 80, seq: 2 });
		expect(v.lines.slice(0, EXPANDED_HEAD)).toEqual(all.slice(0, EXPANDED_HEAD));
		expect(v.lines[EXPANDED_HEAD]).toBe("... 150 lines not shown ...");
		expect(v.lines.slice(-EXPANDED_TAIL)).toEqual(all.slice(-EXPANDED_TAIL));
		expect(v.lines.length).toBe(EXPANDED_HEAD + 1 + EXPANDED_TAIL);
	});
	test("narrow hint is short", () => {
		const v = viewOutput(lines(5), { status: "ok", expanded: true, width: 40, seq: 2 });
		expect(v.hint).toBe("tap to close");
	});
	test("an expanded success with no output says nothing", () => {
		expect(viewOutput([], { status: "ok", expanded: true, width: 80, seq: 1 })).toEqual({
			lines: [],
			hint: null,
		});
	});
});

describe("fit", () => {
	test("every line fits the width minus the gutter, ending in an ellipsis when cut", () => {
		const long = "x".repeat(300);
		for (const width of [40, 52, 100]) {
			const v = viewOutput([long, "short"], { status: "fail", expanded: false, width, seq: 1 });
			for (const l of v.lines) expect(l.length).toBeLessThanOrEqual(width - 4);
			expect(v.lines[0].endsWith("…")).toBe(true);
			expect(v.lines[1]).toBe("short");
		}
	});
	test("a hint never exceeds the width either", () => {
		for (const width of [30, 40, 52, 100]) {
			const v = viewOutput(lines(999), { status: "fail", expanded: false, width, seq: 12345 });
			expect((v.hint ?? "").length).toBeLessThanOrEqual(width - 4);
		}
	});
});
