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
	type FooterSegment,
	buildFooterSegments,
	fitFooterHints,
	fitFooterRow,
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
	const last = stdout.frames.filter((f) => f.includes("mode ") || f.includes("[^P]")).at(-1) ?? "";
	return (
		last
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/\n+$/, "")
			.split("\n")
	);
}

describe("BottomBar renders one footer row, hints included (#3130, #3238)", () => {
	test("160x48: one row, the status then the key caps, nothing wraps", async () => {
		const lines = await frame(160, 48, { ready: 3, total: 3, user: undefined });
		expect(lines.length).toBe(1);
		const row = lines[0] ?? "";
		// Nothing plays: no station segment, the row starts with the mode.
		expect(row.startsWith("mode Planning [^Y]")).toBe(true);
		for (const part of ["session 8m 12s", "[^P] palette", "[^X] plan", "[^C] quit"]) {
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

	test("durable turns are a segment only while on", async () => {
		expect((await frame(160, 48, { durable: true }))[0]).toContain("durable on");
		expect((await frame(160, 48, { durable: false }))[0]).not.toContain("durable");
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
		const failed = buildFooterSegments({ mode: "Planning", judge: "failed" }).find(
			(s) => s.key === "judge",
		);
		const infinite = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "perm",
		);
		const loading = buildFooterSegments({ mode: "Planning", judge: "loading" }).find(
			(s) => s.key === "judge",
		);
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
		expect(
			buildFooterSegments({ mode: "Planning", judge: "ready" }).some((s) => s.key === "judge"),
		).toBe(false);
	});
});

describe("footer segments", () => {
	test("the permission mode prints as a word, never as ?", () => {
		const seg = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "perm",
		);
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
		const segs = buildFooterSegments({
			mode: "Planning",
			sessionTime: "1s",
			user: "u",
			adhd: true,
		});
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
		const kept = fitFooterSegments(
			buildFooterSegments({ mode: "Implementing", sessionTime: "1s" }),
			5,
		);
		expect(kept.map((s) => s.key)).toEqual(["mode"]);
	});

	test("the station segment narrows below 120 columns", () => {
		expect(fmSegmentWidth(160)).toBeGreaterThan(fmSegmentWidth(80));
	});
});

describe("quiet states leave the footer (#3130)", () => {
	test("Ask, the default, is not a segment; every other mode is", () => {
		const has = (permissions: string) =>
			buildFooterSegments({ mode: "Planning", permissions }).some(
				(s) => s.key === "perm" || s.key === "approval",
			);
		expect(has("ask")).toBe(false);
		for (const m of ["plan", "guarded", "infinite"]) expect(has(m)).toBe(true);
	});

	test("the OS login is not a segment; a signed-in name is", async () => {
		expect((await frame(160, 48, { user: undefined }))[0]).not.toContain("user");
		expect((await frame(160, 48, { user: "james", ready: 3, total: 3 }))[0]).toContain(
			"user james",
		);
	});

	test("providers show only when one is down", async () => {
		expect((await frame(160, 48, { ready: 3, total: 3 }))[0]).not.toContain("providers");
		expect((await frame(160, 48, { ready: 2, total: 3 }))[0]).toContain("providers 2/3");
	});

	test("the audit row: approval ask, judge ready and providers 3/3 are gone", async () => {
		const row =
			(await frame(160, 48, { ready: 3, total: 3, judge: "ready", user: undefined }))[0] ?? "";
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
		expect(fitFooterHints(first + 2 + hintWidth(FOOTER_HINTS[1] ?? ""))).toEqual([
			FOOTER_HINTS[0],
			FOOTER_HINTS[1],
		]);
		expect(fitFooterHints(999)).toEqual([...FOOTER_HINTS]);
	});

	test("a cap is the key in brackets, then the verb", () => {
		expect(hintWidth("^X plan")).toBe("[^X] plan".length);
	});
});

describe("run_command without its OS sandbox is a footer segment (#4013)", () => {
	test("no segment when the sandbox applies", () => {
		expect(
			buildFooterSegments({ mode: "Planning" }).find((s) => s.key === "sandbox"),
		).toBeUndefined();
	});

	test("'sandbox off' with the reason, in the look-here colour", () => {
		const seg = buildFooterSegments({ mode: "Planning", sandboxOff: "EIGHT_SEATBELT=0" }).find(
			(s) => s.key === "sandbox",
		);
		const infinite = buildFooterSegments({ mode: "Planning", permissions: "infinite" }).find(
			(s) => s.key === "perm",
		);
		expect(seg?.label).toBe("sandbox");
		expect(seg?.value).toBe("off");
		expect(seg?.note).toBe("EIGHT_SEATBELT=0");
		expect(seg?.color).toBe(infinite?.color);
	});
});

describe("the sandbox segment never costs a hint (#4013, Windows parity)", () => {
	const all = buildFooterSegments({
		mode: "Planning",
		permissions: "ask",
		user: "someone",
		providersLive: 1,
		providersTotal: 2,
		sandboxOff: "unsupported OS",
	});
	const withoutSandbox = all.filter((s) => s.key !== "sandbox");
	const plain = (w: number) => {
		const segments = fitFooterSegments(withoutSandbox, w);
		const room = Math.max(0, w - segmentsWidth(segments) - 3);
		return fitFooterHints(
			room,
			segments.some((s) => s.key === "perm"),
		);
	};

	test("at every width, the row keeps every hint it would show with no sandbox segment", () => {
		for (let w = 40; w <= 220; w++) {
			const row = fitFooterRow(all, w);
			for (const hint of plain(w)) expect(row.hints).toContain(hint);
		}
	});

	test("[^C] quit shows wherever it shows without the segment", () => {
		for (let w = 40; w <= 220; w++) {
			if (plain(w).includes("^C quit")) expect(fitFooterRow(all, w).hints).toContain("^C quit");
		}
	});

	test("wide: the full reason; tighter: 'sandbox off' alone; tightest: 'sbx off', never dropped", () => {
		const shapes = new Set<string>();
		for (let w = 40; w <= 400; w++) {
			const seg = fitFooterRow(all, w).segments.find((s) => s.key === "sandbox");
			shapes.add(seg ? (seg.note ? "full" : seg.label === "sbx" ? "sbx" : "short") : "none");
		}
		expect([...shapes].sort()).toEqual(["full", "sbx", "short"]);
		const wide = fitFooterRow(all, 400).segments.find((s) => s.key === "sandbox");
		expect(wide?.note).toBe("unsupported OS");
		expect(wide?.value).toBe("off");
	});

	test("with the sandbox applied the row is exactly the plain fit", () => {
		for (const w of [80, 120, 160]) {
			const row = fitFooterRow(withoutSandbox, w);
			expect(row.segments).toEqual(fitFooterSegments(withoutSandbox, w));
			expect(row.hints).toEqual(plain(w));
		}
	});
});

describe("the palette cap is reserved at every width, the sandbox state below 60 (#4951)", () => {
	// The idle row on a phone: session time and providers used to fill the row
	// and leave the cap nothing, so it read "mode Planning [^Y] | sandbox off nested".
	const phone = (extra: Partial<Parameters<typeof buildFooterSegments>[0]> = {}) =>
		buildFooterSegments({
			mode: "Planning",
			permissions: "ask",
			sessionTime: "2s",
			providersLive: 2,
			providersTotal: 3,
			sandboxOff: "nested",
			...extra,
		});

	test("[^P] palette is in the row at every width from 38, with or without a sandbox segment", () => {
		const withSb = phone();
		const noSb = phone({ sandboxOff: undefined });
		for (let w = 38; w <= 220; w++) {
			expect(fitFooterRow(withSb, w).hints[0]).toBe("^P palette");
			expect(fitFooterRow(noSb, w).hints[0]).toBe("^P palette");
		}
	});

	test("below 60 columns the sandbox state is never dropped, only shortened", () => {
		const all = phone();
		for (let w = 38; w < 60; w++) {
			const seg = fitFooterRow(all, w).segments.find((s) => s.key === "sandbox");
			expect(seg, `sandbox at ${w}`).toBeDefined();
			expect(seg?.value).toBe("off");
		}
		expect(fitFooterRow(all, 50).segments.find((s) => s.key === "sandbox")?.note).toBeUndefined();
		expect(fitFooterRow(all, 39).segments.find((s) => s.key === "sandbox")?.label).toBe("sbx");
	});

	test("with a permission mode set, both survive a 51 column row", () => {
		const row = fitFooterRow(phone({ permissions: "plan" }), 51);
		expect(row.hints[0]).toBe("^P palette");
		expect(row.segments.some((s) => s.key === "sandbox")).toBe(true);
	});

	test("the real idle frame at 52 and 40 columns keeps the cap and the sandbox word", async () => {
		for (const cols of [52, 40]) {
			const row = (await frame(cols, 30, { sandboxOff: "nested", sessionTime: "2s" }))[0] ?? "";
			expect(row, `row at ${cols}`).toContain("[^P] palette");
			expect(row, `row at ${cols}`).toMatch(/(sandbox|sbx) off/);
			expect(row.length).toBeLessThanOrEqual(cols);
		}
	});
});

describe("the context meter segment (#4956)", () => {
	const ctx = { used: 31200, window: 128000, stale: false };
	const segs = (extra: Partial<Parameters<typeof buildFooterSegments>[0]> = {}) =>
		buildFooterSegments({ mode: "Planning", permissions: "ask", columns: 100, ctx, ...extra });

	test("percent, then used of window, in the muted colour while calm", () => {
		const seg = segs().find((s) => s.key === "ctx");
		expect(seg?.label).toBe("ctx");
		expect(seg?.value).toBe("24% 31.2k/128k");
		expect(seg?.bold).toBeFalsy();
	});

	test("warm at 70 percent, red and bold at 90, and they differ from calm", () => {
		const at = (used: number) => segs({ ctx: { ...ctx, used } }).find((s) => s.key === "ctx");
		const calm = at(31200)?.color;
		const warn = at(100000)?.color;
		const danger = at(120000);
		expect(warn).not.toBe(calm);
		expect(danger?.color).not.toBe(warn);
		expect(danger?.bold).toBe(true);
		expect(danger?.value).toContain("!");
	});

	test("right after a compaction it reads ? and never the old number", () => {
		const seg = segs({ ctx: { ...ctx, stale: true } }).find((s) => s.key === "ctx");
		expect(seg?.value).toBe("?/128k");
		expect(seg?.value).not.toContain("24");
	});

	test("no measurement yet: no segment", () => {
		expect(segs({ ctx: { ...ctx, used: null } }).some((s) => s.key === "ctx")).toBe(false);
		expect(segs({ ctx: undefined }).some((s) => s.key === "ctx")).toBe(false);
	});

	test("with the sandbox off and a palette cap, the meter shortens before anything vital goes (52 columns)", () => {
		const all = segs({ columns: 52, sandboxOff: "nested", sessionTime: "2s" });
		const row = fitFooterRow(all, 51);
		expect(row.hints[0]).toBe("^P palette");
		expect(row.segments.some((s) => s.key === "sandbox")).toBe(true);
		expect(row.segments.find((s) => s.key === "ctx")?.value).toBe("24%");
	});

	test("at 40 columns without a sandbox segment the meter and the cap both fit", () => {
		const row = fitFooterRow(segs({ columns: 40 }), 39);
		expect(row.hints[0]).toBe("^P palette");
		expect(row.segments.some((s) => s.key === "ctx")).toBe(true);
	});

	test("at every width from 38 the cap stays, and below 60 the sandbox stays", () => {
		for (const sandboxOff of [undefined, "nested"]) {
			for (let w = 38; w <= 220; w++) {
				const all = segs({
					columns: w + 1,
					sandboxOff,
					sessionTime: "2s",
					providersLive: 1,
					providersTotal: 2,
				});
				const row = fitFooterRow(all, w);
				expect(row.hints[0], `cap at ${w}`).toBe("^P palette");
				if (sandboxOff && w < 60) expect(row.segments.some((s) => s.key === "sandbox")).toBe(true);
			}
		}
	});

	test("rendered at 100x32: the footer row reads the meter after the mode", async () => {
		const row = (await frame(100, 32, { ctx }))[0] ?? "";
		expect(row).toContain("ctx 24% 31.2k/128k");
		expect(row).toContain("[^P] palette");
	});

	test("rendered at 52 and 40 columns with the sandbox off: cap and sandbox word stay", async () => {
		for (const cols of [52, 40]) {
			const row = (await frame(cols, 30, { ctx, sandboxOff: "nested" }))[0] ?? "";
			expect(row, `row at ${cols}`).toContain("[^P] palette");
			expect(row, `row at ${cols}`).toMatch(/(sandbox|sbx) off/);
			expect(row.length).toBeLessThanOrEqual(cols);
		}
		const row52 = (await frame(52, 30, { ctx, sandboxOff: "nested" }))[0] ?? "";
		expect(row52).toContain("ctx 24%");
	});
});

describe("the sandbox state is never dropped, at any width (#4953, 8SO ruling)", () => {
	const build = (meter: boolean, columns: number) =>
		buildFooterSegments({
			mode: "Planning",
			permissions: "ask",
			sessionTime: "2s",
			providersLive: 2,
			providersTotal: 3,
			sandboxOff: "nested",
			columns,
			...(meter ? { ctx: { used: 31200, window: 128000, stale: false } } : {}),
		});

	test("widths 38 to 220, meter on and off: the sandbox word and [^P] palette stay", () => {
		for (const meter of [false, true]) {
			for (let w = 38; w <= 220; w++) {
				const row = fitFooterRow(build(meter, w + 1), w);
				const sb = row.segments.find((s) => s.key === "sandbox");
				expect(sb, `sandbox at ${w}, meter ${meter}`).toBeDefined();
				expect(sb?.value).toBe("off");
				expect(row.hints[0], `cap at ${w}, meter ${meter}`).toBe("^P palette");
			}
		}
	});

	test("160 columns with the meter: the sandbox word and every hint the row had without the sandbox stay", () => {
		const row = fitFooterRow(build(true, 160), 159);
		expect(row.segments.some((s) => s.key === "sandbox")).toBe(true);
		expect(row.hints).toContain("^P palette");
		expect(row.hints).toContain("^C quit");
	});

	test("the meter outlives the low-priority segments: present at every width where it fits after shedding", () => {
		for (const used of [31200, 100000, 120000]) {
			const full = (w: number) =>
				buildFooterSegments({
					mode: "Planning",
					permissions: "ask",
					sessionTime: "8m 12s",
					providersLive: 1,
					providersTotal: 2,
					user: "someone",
					tokensPerSecond: 30,
					sandboxOff: "nested",
					columns: w + 1,
					ctx: { used, window: 128000, stale: false },
				});
			for (let w = 80; w <= 220; w++) {
				const all = full(w);
				const need = ["mode", "sandbox", "ctx"].map(
					(k) => all.find((x) => x.key === k) as FooterSegment,
				);
				// Mode, the sandbox in its full form, the meter, and the cap: the least a wide row holds.
				const minimal = segmentsWidth(need) + 3 + 15;
				const row = fitFooterRow(all, w);
				if (w >= minimal) {
					expect(
						row.segments.some((x) => x.key === "ctx"),
						`meter at ${w}, used ${used}`,
					).toBe(true);
				}
				expect(row.segments.some((x) => x.key === "sandbox")).toBe(true);
				expect(row.hints[0]).toBe("^P palette");
			}
		}
	});

	test("90 percent at 120 to 160 columns: rate, providers, user and session never outlast the meter", () => {
		for (let w = 120; w <= 160; w++) {
			const all = buildFooterSegments({
				mode: "Planning",
				permissions: "ask",
				sessionTime: "8m 12s",
				providersLive: 1,
				providersTotal: 2,
				user: "someone",
				tokensPerSecond: 30,
				sandboxOff: "nested",
				columns: w + 1,
				ctx: { used: 120000, window: 128000, stale: false },
			});
			const row = fitFooterRow(all, w);
			const keys = row.segments.map((x) => x.key);
			if (!keys.includes("ctx")) {
				for (const low of ["rate", "providers", "user", "session"]) {
					expect(keys, `${low} kept without the meter at ${w}`).not.toContain(low);
				}
			}
			expect(keys, `meter at ${w}`).toContain("ctx");
		}
	});

	test("the sandbox shrinks to 'sbx off' when it must, never to nothing", () => {
		const shapes = new Set<string>();
		for (let w = 38; w <= 400; w++) {
			const seg = fitFooterRow(build(true, w + 1), w).segments.find((s) => s.key === "sandbox");
			shapes.add(seg ? (seg.note ? "full" : seg.label === "sbx" ? "sbx" : "short") : "none");
		}
		expect([...shapes].sort()).toEqual(["full", "sbx", "short"]);
	});
});

describe("a gated turn shows one word at the right end of the bar (#4510)", () => {
	test("unverified and tests-claimed-not-run render last, in the warning colour", async () => {
		const warn = buildFooterSegments({ mode: "Planning", sandboxOff: "x" }).find(
			(x) => x.key === "sandbox",
		);
		for (const [v, word] of [
			["unverified", "unverified"],
			["tests_claimed_not_run", "tests-claimed-not-run"],
		] as const) {
			const segs = buildFooterSegments({ mode: "Planning", sessionTime: "8m", verification: v });
			expect(segs.at(-1)?.value).toBe(word);
			expect(segs.at(-1)?.color).toBe(warn?.color);
			const row = (await frame(160, 48, { verification: v }))[0] ?? "";
			expect(row).toContain(word);
			expect(row.indexOf(word)).toBeGreaterThan(row.indexOf("session 8m 12s"));
		}
	});

	test("verified and absent draw nothing", async () => {
		for (const v of [undefined, "verified"] as const) {
			expect(
				buildFooterSegments({ mode: "Planning", verification: v }).some(
					(x) => x.key === "verification",
				),
			).toBe(false);
			expect((await frame(160, 48, { verification: v }))[0] ?? "").not.toContain("verified");
		}
	});
});

describe("the word is held per tab (#4510)", () => {
	const byTab: Record<string, Props["verification"]> = { A: "unverified", B: undefined };
	test("a flagged turn on tab A is not drawn under tab B, and is back on A", async () => {
		expect((await frame(160, 48, { verification: byTab.B }))[0] ?? "").not.toContain("unverified");
		expect((await frame(160, 48, { verification: byTab.A }))[0] ?? "").toContain("unverified");
	});
	test("switching back to A shows A's word and B shows nothing", async () => {
		const row = async (tab: string) =>
			(await frame(160, 48, { verification: byTab[tab] }))[0] ?? "";
		expect(await row("A")).toContain("unverified");
		expect(await row("B")).not.toContain("unverified");
	});
});

describe("attached to the daemon is a footer chip while it holds (#4829)", () => {
	test("no segment when the TUI runs on its own", () => {
		expect(
			buildFooterSegments({ mode: "Planning" }).find((s) => s.key === "daemon"),
		).toBeUndefined();
		expect(
			buildFooterSegments({ mode: "Planning", daemonAttached: false }).find(
				(s) => s.key === "daemon",
			),
		).toBeUndefined();
	});

	test("'daemon attached' when linked, and it outlasts the quiet segments", () => {
		const segs = buildFooterSegments({ mode: "Planning", daemonAttached: true });
		const seg = segs.find((s) => s.key === "daemon");
		expect(seg?.label).toBe("daemon");
		expect(seg?.value).toBe("attached");
		expect(seg?.priority).toBeLessThan(
			buildFooterSegments({ mode: "Planning", sessionTime: "1m" }).find((s) => s.key === "session")!
				.priority,
		);
	});
});
