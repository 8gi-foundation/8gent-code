/**
 * The context meter and /context (#4956): number formats, the footer text at
 * wide and narrow widths, the stale state after a compaction, the colour
 * steps, and the part-by-part report.
 */
import { describe, expect, test } from "bun:test";
import {
	classifyContext,
	ctxLevel,
	ctxText,
	fmtTokens,
	formatContextReport,
} from "./context-view.js";

describe("fmtTokens", () => {
	test("reads the way the mocks do", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(842)).toBe("842");
		expect(fmtTokens(3100)).toBe("3.1k");
		expect(fmtTokens(31200)).toBe("31.2k");
		expect(fmtTokens(128000)).toBe("128k");
		expect(fmtTokens(10000)).toBe("10k");
		expect(fmtTokens(1_200_000)).toBe("1.2M");
		expect(fmtTokens(Number.NaN)).toBe("0");
	});
});

describe("colour steps", () => {
	test("calm below 70, warn from 70, danger from 90", () => {
		expect(ctxLevel(0)).toBe("ok");
		expect(ctxLevel(69)).toBe("ok");
		expect(ctxLevel(70)).toBe("warn");
		expect(ctxLevel(89)).toBe("warn");
		expect(ctxLevel(90)).toBe("danger");
		expect(ctxLevel(100)).toBe("danger");
	});
});

describe("footer text", () => {
	const base = { used: 31200, window: 128000, stale: false, columns: 100 };
	test("wide: percent, then used of window", () => {
		expect(ctxText(base)).toEqual({ value: "24% 31.2k/128k", level: "ok" });
	});
	test("below 60 columns: the percent alone", () => {
		expect(ctxText({ ...base, columns: 52 })?.value).toBe("24%");
		expect(ctxText({ ...base, columns: 40 })?.value).toBe("24%");
	});
	test("danger carries a bang so colour is not the only signal", () => {
		expect(ctxText({ ...base, used: 120000, columns: 52 })).toEqual({
			value: "94%!",
			level: "danger",
		});
		expect(ctxText({ ...base, used: 100000 })?.level).toBe("warn");
	});
	test("right after a compaction: a question mark, never the stale number", () => {
		expect(ctxText({ ...base, stale: true })).toEqual({ value: "?/128k", level: "stale" });
		expect(ctxText({ ...base, stale: true, columns: 40 })?.value).toBe("?");
		expect(ctxText({ ...base, stale: true, window: null })?.value).toBe("?");
	});
	test("no measurement yet: nothing, not a zero", () => {
		expect(ctxText({ ...base, used: null })).toBeNull();
		expect(ctxText({ ...base, used: 0 })).toBeNull();
	});
	test("no known window: tokens only, never a percent", () => {
		expect(ctxText({ ...base, window: null })).toEqual({ value: "31.2k", level: "ok" });
	});
	test("a full window clamps at 100", () => {
		expect(ctxText({ ...base, used: 999999 })?.value.startsWith("100%!")).toBe(true);
	});
});

describe("/context", () => {
	const history = [
		{ role: "system", content: "s".repeat(4000) },
		{
			role: "user",
			content: "[Session context from the harness, not typed by the user]\n\nmemory",
		},
		{ role: "user", content: "[harness] note" },
		{ role: "user", content: "fix the bug" },
		{ role: "assistant", content: "ok".repeat(100) },
		{ role: "tool", content: "t".repeat(2000) },
	];
	test("sorts the history into four parts, always all four, in order", () => {
		const rows = classifyContext(history);
		expect(rows.map((r) => r.part)).toEqual(["system", "notes", "history", "tools"]);
		expect(rows.map((r) => r.messages)).toEqual([1, 2, 2, 1]);
		expect(classifyContext([]).map((r) => r.tokens)).toEqual([0, 0, 0, 0]);
	});
	test("sizes use the compactor's estimate", () => {
		const rows = classifyContext(history);
		expect(rows[0]!.tokens).toBe(Math.ceil(4000 / 4) + 4);
		expect(rows[3]!.tokens).toBe(Math.ceil(2000 / 4) + 4);
	});
	test("the report totals the parts, names the window, and fits a phone line", () => {
		const rows = classifyContext(history);
		const out = formatContextReport(rows, 128000, { measured: 31200 });
		const total = rows.reduce((s, r) => s + r.tokens, 0);
		expect(out).toContain("system prompt");
		expect(out).toContain("tool output");
		expect(out).toContain("total");
		expect(out).toContain(`est of 128k (${Math.round((total / 128000) * 100)}%)`);
		expect(out).toContain("Last measured turn: 31.2k tokens.");
		expect(out).toContain("/stack");
		for (const line of out.split("\n").slice(0, 5)) expect(line.length).toBeLessThanOrEqual(40);
	});
	test("after a compaction the report says the meter is waiting", () => {
		expect(formatContextReport(classifyContext(history), 128000, { stale: true })).toContain(
			"reads ? until the next turn",
		);
	});
	test("an unknown window omits 'of N'", () => {
		expect(formatContextReport(classifyContext(history), null)).not.toContain(" of ");
	});
});

describe("wiring (#4956)", () => {
	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	const { join } = require("node:path") as typeof import("node:path");
	const app = readFileSync(join(import.meta.dir, "..", "app.tsx"), "utf8");
	test("the app listens for compaction and blanks the meter until the next measured turn", () => {
		expect(app).toContain("onCompaction: () => {");
		expect(app).toContain("setContextStale(true)");
		expect(app).toContain("setContextStale(false)");
	});
	test("/context is a real command in the registry and in the app", () => {
		const reg = readFileSync(join(import.meta.dir, "slash-commands.ts"), "utf8");
		expect(reg).toContain('name: "context"');
		expect(app).toContain('case "context":');
	});
});
