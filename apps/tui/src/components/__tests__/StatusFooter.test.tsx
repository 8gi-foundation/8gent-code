/**
 * The one-row footer (mockup A, HUD system #3238). It holds what the person
 * sets (the ^Y mode, the permission mode) and the session, then the key
 * caps. These tests render the real BottomBar into fake 80x45 and 160x48
 * terminals and check height, content and the rules: nothing wraps, ^Y
 * stays visible, one home per fact, quiet states are not shown.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BottomBar } from "../BottomBar.js";
import {
	FOOTER_HINTS,
	FOOTER_SEPARATOR,
	buildFooterSegments,
	fitFooterHints,
	fitFooterSegments,
	fmSegmentWidth,
	hintWidth,
	segmentsWidth,
} from "../StatusFooter.js";

function fakeStdout(cols: number, rows: number) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(s);
		return true;
	};
	return out;
}

type Props = Parameters<typeof BottomBar>[0];

const base: Props = {
	ready: 2,
	total: 3,
	user: "james",
	permissions: "ask",
	sessionTime: "8m 12s",
	mode: "Planning",
};

async function frame(cols: number, rows: number, props: Partial<Props> = {}): Promise<string[]> {
	const stdout = fakeStdout(cols, rows);
	const app = render(<BottomBar {...base} {...props} />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	await new Promise((r) => setTimeout(r, 30));
	app.unmount();
	const last = stdout.frames.filter((f) => f.includes("mode ")).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\n+$/, "").split("\n");
}

describe("BottomBar renders one footer row, hints included (#3130, #3238)", () => {
	test("160x48: one row, the status then the key caps, nothing wraps", async () => {
		const lines = await frame(160, 48, { ready: 3, total: 3, user: undefined });
		expect(lines.length).toBe(1);
		const row = lines[0] ?? "";
		// Nothing plays: no station segment, the row starts with the mode.
		expect(row.startsWith("mode Planning [^Y]")).toBe(true);
		for (const part of ["session 8m 12s", "[^P] palette", "[^X] plan", "[^O] expand"]) {
			expect(row).toContain(part);
		}
		expect(row.indexOf("[^P] palette")).toBeGreaterThan(row.indexOf("session 8m 12s"));
		expect(row.length).toBeLessThanOrEqual(159);
		expect(row).not.toContain("╭");
	});

	test("one home per fact: no model, tokens, branch or FM idle in the footer (#3238)", async () => {
		const row = (await frame(160, 48, { ready: 3, total: 3 }))[0] ?? "";
		for (const gone of ["model", "tokens", "branch", "8GENT FM", "idle", "agent pulse"]) {
			expect(row).not.toContain(gone);
		}
	});

	test("Ctrl+C is taught as quit, because it saves and quits (#3238)", () => {
		expect(FOOTER_HINTS).toContain("^C quit");
		expect(FOOTER_HINTS.some((h) => h.includes("clear"))).toBe(false);
	});

	test("80x45: one row with mode and the palette key cap", async () => {
		const lines = await frame(80, 45);
		expect(lines.length).toBe(1);
		const row = lines[0] ?? "";
		expect(row).toContain("mode Planning [^Y]");
		expect(row).toContain("[^P] palette");
		expect(row.length).toBeLessThanOrEqual(79);
	});

	test("short terminal: still one row", async () => {
		const lines = await frame(80, 30);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("mode Planning [^Y]");
	});

	test("every width from 60 to 200 draws one row that fits, key caps whole or absent", async () => {
		for (const cols of [60, 72, 80, 100, 120, 140, 160, 200]) {
			const lines = await frame(cols, 48, { ready: 3, total: 3 });
			expect({ cols, rows: lines.length }).toEqual({ cols, rows: 1 });
			const row = lines[0] ?? "";
			expect(row.length).toBeLessThanOrEqual(cols - 1);
			const caps = [...row.matchAll(/\[([^\]]+)\] ([a-zA-Z]+)/g)].map((m) => `${m[1]} ${m[2]}`);
			for (const hint of caps) expect(FOOTER_HINTS as readonly string[]).toContain(hint);
		}
	});

	test("the mode segment follows ^Y", async () => {
		const row = (await frame(160, 48, { mode: "Debugging" }))[0] ?? "";
		expect(row).toContain("mode Debugging [^Y]");
	});

	test("ADHD mode is a segment only while on (it lived in the context rail, #3238)", async () => {
		expect((await frame(160, 48, { adhd: true }))[0]).toContain("adhd on");
		expect((await frame(160, 48, { adhd: false }))[0]).not.toContain("adhd");
	});

	test("unknown values are not shown", async () => {
		const row = (await frame(160, 48, { total: 0, ready: 0, sessionTime: "—" }))[0] ?? "";
		expect(row).not.toContain("providers");
		expect(row).not.toContain("session");
		expect(row).not.toContain("—");
	});
});

describe("the System One judge is a footer segment, not a chat line (#3090)", () => {
	test("no segment while System One is off", async () => {
		const row = (await frame(160, 48))[0] ?? "";
		expect(row).not.toContain("judge");
	});

	test("loading and failed read as one word after 'judge'", () => {
		for (const judge of ["loading", "failed"] as const) {
			const seg = buildFooterSegments({ mode: "Planning", judge }).find((s) => s.key === "judge");
			expect(seg?.label).toBe("judge");
			expect(seg?.value).toBe(judge);
		}
	});

	test("failed is the look-here colour, like the Infinite permission mode", () => {
		const failed = buildFooterSegments({ mode: "Planning", judge: "failed" }).find((s) => s.key === "judge");
		const infinite = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "perm",
		);
		const loading = buildFooterSegments({ mode: "Planning", judge: "loading" }).find((s) => s.key === "judge");
		expect(failed?.color).toBe(infinite?.color);
		expect(loading?.color).not.toBe(infinite?.color);
	});

	test("80x45: loading and failed survive the squeeze; ready gives way", async () => {
		for (const judge of ["loading", "failed"] as const) {
			const row = (await frame(80, 45, { judge }))[0] ?? "";
			expect(row).toContain(`judge ${judge}`);
			expect(row).toContain("mode Planning [^Y]");
			expect(row.length).toBeLessThanOrEqual(79);
		}
		const ready = (await frame(80, 45, { judge: "ready" }))[0] ?? "";
		expect(ready).not.toContain("judge");
	});

	test("'judge ready' is the quiet state and is not shown (#3130)", async () => {
		const row = (await frame(160, 48, { judge: "ready", user: undefined }))[0] ?? "";
		expect(row).not.toContain("judge");
		expect(buildFooterSegments({ mode: "Planning", judge: "ready" }).some((s) => s.key === "judge")).toBe(false);
	});
});

describe("footer segments", () => {
	test("the permission mode prints as a word, never as ?", () => {
		const seg = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find((s) => s.key === "perm");
		expect(seg?.value).toBe("Infinite");
	});

	test("the Infinite permission mode is kept as long as the mode", () => {
		const segs = buildFooterSegments({
			mode: "Planning",
			permissions: "infinite",
			sessionTime: "8m 12s",
			user: "james",
		});
		const kept = fitFooterSegments(segs, 40).map((s) => s.key);
		expect(kept).toContain("mode");
		expect(kept).toContain("perm");
	});

	test("fit keeps display order and drops the highest priority first", () => {
		const segs = buildFooterSegments({ mode: "Planning", sessionTime: "1s", user: "u", adhd: true });
		const all = fitFooterSegments(segs, 999).map((s) => s.key);
		expect(all).toEqual(["mode", "adhd", "user", "session"]);
		const some = fitFooterSegments(segs, 45).map((s) => s.key);
		expect(some).toEqual(["mode", "adhd", "session"]);
		expect(segmentsWidth(fitFooterSegments(segs, 45))).toBeLessThanOrEqual(45);
	});

	test("a leading station adds one separator before the first segment", () => {
		const segs = buildFooterSegments({ mode: "Planning" });
		expect(segmentsWidth(segs, true) - segmentsWidth(segs)).toBe(FOOTER_SEPARATOR.length);
	});

	test("mode is never dropped, even when nothing fits", () => {
		const kept = fitFooterSegments(buildFooterSegments({ mode: "Implementing", sessionTime: "1s" }), 5);
		expect(kept.map((s) => s.key)).toEqual(["mode"]);
	});

	test("the station segment narrows below 120 columns", () => {
		expect(fmSegmentWidth(160)).toBeGreaterThan(fmSegmentWidth(80));
	});
});

describe("quiet states leave the footer (#3130)", () => {
	test("Ask, the default, is not a segment; every other mode is", () => {
		const has = (permissions: string) =>
			buildFooterSegments({ mode: "Planning", permissions }).some((s) => s.key === "perm" || s.key === "approval");
		expect(has("ask")).toBe(false);
		for (const m of ["plan", "guarded", "infinite"]) expect(has(m)).toBe(true);
	});

	test("the OS login is not a segment; a signed-in name is", async () => {
		expect((await frame(160, 48, { user: undefined }))[0]).not.toContain("user");
		expect((await frame(160, 48, { user: "james", ready: 3, total: 3 }))[0]).toContain("user james");
	});

	test("providers show only when one is down", async () => {
		expect((await frame(160, 48, { ready: 3, total: 3 }))[0]).not.toContain("providers");
		expect((await frame(160, 48, { ready: 2, total: 3 }))[0]).toContain("providers 2/3");
	});

	test("the audit row: approval ask, judge ready and providers 3/3 are gone", async () => {
		const row = (await frame(160, 48, { ready: 3, total: 3, judge: "ready", user: undefined }))[0] ?? "";
		for (const quiet of ["approval", "judge", "providers"]) expect(row).not.toContain(quiet);
		expect(row).toContain("mode Planning [^Y]");
	});
});

describe("footer key caps (#3238)", () => {
	test("[^P] palette leads: at 80 columns it is the hint that stays", () => {
		expect(FOOTER_HINTS[0]).toBe("^P palette");
		expect(fitFooterHints(hintWidth("^P palette"))).toEqual(["^P palette"]);
	});

	test("most used first, whole or not at all", () => {
		const first = hintWidth(FOOTER_HINTS[0] ?? "");
		expect(fitFooterHints(0)).toEqual([]);
		expect(fitFooterHints(first - 1)).toEqual([]);
		expect(fitFooterHints(first)).toEqual([FOOTER_HINTS[0]]);
		expect(fitFooterHints(first + 2 + hintWidth(FOOTER_HINTS[1] ?? ""))).toEqual([FOOTER_HINTS[0], FOOTER_HINTS[1]]);
		expect(fitFooterHints(999)).toEqual([...FOOTER_HINTS]);
	});

	test("a cap is the key in brackets, then the verb", () => {
		expect(hintWidth("^X plan")).toBe("[^X] plan".length);
	});
});
