/**
 * #9: the context reading is drawn once. The footer is its home wherever main's
 * footer draws it; the NOW strip draws it only when the footer row does not.
 *
 * Every check reads the DRAWN rows (rendered, ANSI stripped, measured by
 * display width), never a fitted list. Widths 30 to 200, four window states,
 * nine row states, with and without the DJ station.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { Box, renderToString } from "ink";
import React from "react";
import stringWidth from "string-width";
import { chatColumnWidth } from "../../lib/chat-layout.js";
import { LiveFocalStrip } from "../LiveFocalStrip.js";
import {
	type FooterData,
	StatusSegments,
	fmSegmentWidth,
	footerDrawsCtx,
	footerHoldsCtx,
} from "../StatusFooter.js";

/** A fixed finish time: "finished 9:51 AM" is as wide on every run, whatever the clock says. */
const ENDED_AT = new Date(2026, 10, 20, 9, 51).getTime();

const WINDOWS = {
	known: { ctx: { used: 24700, window: 32768, stale: false }, pct: 75, state: "server" },
	unknown: { ctx: { used: 24700, window: null, stale: false }, pct: null, state: "unknown" },
	full: { ctx: { used: 31500, window: 32768, stale: false }, pct: 96, state: "provider" },
	stale: { ctx: { used: 24700, window: 32768, stale: true }, pct: null, state: "fresh" },
} as const;

const rich: Partial<FooterData> = {
	permissions: "guarded",
	localChip: "92% local today",
	sessionTime: "8m 12s",
	daemonAttached: true,
	providersLive: 2,
	providersTotal: 3,
	user: "sam",
	thinking: "auto",
};
const run = { turnRunning: true, turnCalls: 12 };
const ROWS: Record<string, Partial<FooterData>> = {
	rich,
	running: { ...rich, ...run },
	sandbox: { ...rich, sandboxOff: "nested" },
	sandboxRunning: { ...rich, ...run, sandboxOff: "nested" },
	flagged: { ...rich, verification: "tests_claimed_not_run" },
	bare: { permissions: "ask" },
	judgeFailed: { ...rich, judge: "failed" },
	judgeLoading: { ...rich, judge: "loading" },
	held: { ...rich, permHeld: true },
};

/**
 * What main's own footer already fails, recorded on main (3d179b12): #316. Not
 * fixed here, since this PR leaves the footer fitter as main has it. Each check
 * asserts its failures are exactly these, so none is skipped and none is added.
 */
const MAIN_FAILS: Record<string, Record<string, string>> = {
	fit: {
		"bare station": "30-31",
		held: "30-47",
		"held station": "30-60",
		judgeFailed: "30-40",
		"judgeFailed station": "30-53",
		judgeLoading: "30-40",
		"judgeLoading station": "30-53",
		rich: "30-40",
		"rich station": "30-53",
		running: "30-40",
		"running station": "30-53",
		"sandbox station": "30-36",
		"sandboxRunning station": "30-36",
	},
	sandbox: { "sandbox station": "30-36", "sandboxRunning station": "30-36" },
	stop: {
		running: "30-66",
		"running station": "30-79",
		sandboxRunning: "30-49,56-77,85-87",
		"sandboxRunning station": "30-62,69-90,98-100",
	},
	judge: {
		judgeFailed: "30-70",
		"judgeFailed station": "30-83",
		judgeLoading: "30-71",
		"judgeLoading station": "30-84",
	},
	flag: {
		"flagged known": "60,72-78",
		"flagged full": "60,73-79",
		"flagged stale": "60,68-74",
		"flagged unknown": "60,68-74",
		"flagged known station": "63-70,85-91",
		"flagged full station": "63-70,86-92",
		"flagged stale station": "63-70,81-87",
		"flagged unknown station": "63-70,81-87",
	},
};

/**
 * The price of a meter that never moves (#308, option A): an idle row whose footer
 * has room for ctx, while its running row does not, draws it in both the footer and
 * the strip, as main did. Every case, recorded at this head. None is mid-turn.
 */
const IDLE_TWICE: Record<string, string> = {
	"bare full": "60-67",
	"bare full station": "57-59,65-80",
	"bare known": "60-66",
	"bare known station": "57-59,64-79",
	"bare stale station": "57-66,71",
	"bare unknown": "66-76",
	"bare unknown station": "57-59,79-89",
	"flagged full": "73-79,103-113",
	"flagged full station": "57-59,86-89,92,116-119,128-138",
	"flagged known": "72-79,102-112",
	"flagged known station": "57-59,85-89,92,115-119,127-137",
	"flagged stale": "141-144,148-151,156-158",
	"flagged stale station": "166-169,173-176,181-183",
	"flagged unknown": "166-176",
	"flagged unknown station": "191-200",
	"held full": "86-89,92-96",
	"held full station": "99-109,121-131",
	"held known": "85-89,92-95",
	"held known station": "98-108,120-130",
	"held stale": "134-137,141-144,149-151",
	"held stale station": "159-162,166-169,174-176",
	"held unknown": "159-169",
	"held unknown station": "184-194",
	"judgeFailed full": "94-104",
	"judgeFailed full station": "107-117,120-129",
	"judgeFailed known": "93-103",
	"judgeFailed known station": "106-116,120-128",
	"judgeFailed stale": "132-135,139-142,147-149",
	"judgeFailed stale station": "157-160,164-167,172-174",
	"judgeFailed unknown": "157-167",
	"judgeFailed unknown station": "182-192",
	"judgeLoading full": "95-105",
	"judgeLoading full station": "108-118,120-130",
	"judgeLoading known": "94-104",
	"judgeLoading known station": "107-117,120-129",
	"judgeLoading stale": "133-136,140-143,148-150",
	"judgeLoading stale station": "158-161,165-168,173-175",
	"judgeLoading unknown": "158-168",
	"judgeLoading unknown station": "183-193",
	"rich full": "57-59,79-89",
	"rich full station": "92-102",
	"rich known": "57-59,78-88",
	"rich known station": "92-101",
	"rich stale": "117-120,124-127,132-134",
	"rich stale station": "142-145,149-152,157-159",
	"rich unknown": "142-152",
	"rich unknown station": "167-177",
	"sandbox full": "79-84,96-100",
	"sandbox full station": "92-97,109-113,121-125",
	"sandbox known": "78-84,96-99",
	"sandbox known station": "92-97,109-112,121-124",
	"sandbox stale": "120,127-130,132-137",
	"sandbox stale station": "145,152-155,157-162",
	"sandbox unknown": "143-153",
	"sandbox unknown station": "168-178",
};

/** Check 8: where only the strip's own room decides whether it draws the meter. */
const STRIP_ROOM: Record<string, string> = {
	"rich full": "50-56",
	"rich known": "50-56",
	"rich stale": "50-56,90-91",
	"rich station": "50-56,90-91",
	"rich unknown": "50-56,90-91",
	"sandbox full": "50-56",
	"sandbox known": "50-56",
	"sandbox stale": "50-56,90-91",
	"sandbox station": "50-56,90-91",
	"sandbox unknown": "50-56,90-91",
};

const plain = (s: string) => stripVTControlCharacters(s);

interface Case {
	name: string;
	row: string;
	columns: number;
	width: number;
	footer: string;
	strip: string;
	drawsCtx: boolean;
	/** The footer is the meter's home (decided from the mid-turn row), as app.tsx wires it. */
	home: boolean;
}

const stripCache = new Map<string, string>();
function drawStrip(columns: number, w: keyof typeof WINDOWS, running: boolean, meter: boolean) {
	const key = `${columns}:${w}:${running}:${meter}`;
	const hit = stripCache.get(key);
	if (hit !== undefined) return hit;
	const width = chatColumnWidth(columns, { activity: columns >= 90 });
	const out = plain(
		renderToString(
			<LiveFocalStrip
				mode="Planning"
				activeStep={running ? "read_file" : "idle"}
				route="qwen3.5:9b-32k"
				tokens="71K tok"
				contextPct={WINDOWS[w].pct}
				contextState={WINDOWS[w].state}
				meter={meter}
				isProcessing={running}
				lastTurnEndedAt={running ? null : ENDED_AT}
				lastTurnSuccess={running ? null : true}
				animate={false}
				width={width}
			/>,
			{ columns: width },
		),
	);
	stripCache.set(key, out);
	return out;
}

const cases: Case[] = [];
for (let columns = 30; columns <= 200; columns++) {
	for (const station of [false, true]) {
		const width = Math.max(0, columns - (station ? fmSegmentWidth(columns) : 0) - 1);
		for (const w of Object.keys(WINDOWS) as Array<keyof typeof WINDOWS>) {
			for (const [row, extra] of Object.entries(ROWS)) {
				const data: FooterData = { mode: "Planning", columns, ctx: WINDOWS[w].ctx, ...extra };
				const footer = plain(
					renderToString(
						<Box width={width + 1}>
							<StatusSegments data={data} width={width} leading={station} dj={station} />
						</Box>,
						{ columns: width + 1 },
					),
				).trimEnd();
				const drawsCtx = footerDrawsCtx(data, width, station, station);
				const home = footerHoldsCtx(data, width, station, station);
				const running = Boolean(extra.turnRunning);
				cases.push({
					name: `w${columns} ${row} ${w}${station ? " station" : ""}`,
					row,
					columns,
					width,
					footer,
					strip: drawStrip(columns, w, running, !home),
					drawsCtx,
					home,
				});
			}
		}
	}
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const ctxCount = (s: string) => (s.match(/\bctx\b/g) ?? []).length;

/**
 * The cases a check fails, by row state and station, as runs of terminal widths
 * ("30-57,61"). The window state is named only where it changes the runs.
 */
function failing(pred: (c: Case) => boolean): Record<string, string> {
	const cols: Record<string, number[]> = {};
	for (const c of cases.filter((x) => !pred(x)))
		(cols[c.name.replace(/^w\d+ /, "")] ??= []).push(c.columns);
	const runs = (list: number[] = []) =>
		list
			.reduce<number[][]>((acc, n) => {
				const last = acc[acc.length - 1];
				if (last && last[1] === n - 1) last[1] = n;
				else acc.push([n, n]);
				return acc;
			}, [])
			.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
			.join(",");
	const out: Record<string, string> = {};
	for (const row of Object.keys(ROWS)) {
		for (const st of ["", " station"]) {
			const per = Object.keys(WINDOWS).map((w) => runs(cols[`${row} ${w}${st}`]));
			if (per.every((r) => r === per[0])) {
				if (per[0]) out[`${row}${st}`] = per[0];
			} else Object.keys(WINDOWS).forEach((w, i) => per[i] && (out[`${row} ${w}${st}`] = per[i]));
		}
	}
	return out;
}

describe("footer and NOW strip draw the context reading once (#9)", () => {
	test("1. the drawn footer row never exceeds its width and no segment is cut", () => {
		expect(
			failing(
				(c) =>
					!c.footer.includes("\n") &&
					stringWidth(c.footer) <= c.width &&
					!c.footer.includes("\u2026"),
			),
		).toEqual(MAIN_FAILS.fit);
	});

	test("2. sandbox off is drawn in full", () => {
		const forms = /(sandbox off|sbx off|sb off)/;
		expect(failing((c) => !c.row.startsWith("sandbox") || forms.test(c.footer))).toEqual(
			MAIN_FAILS.sandbox,
		);
	});

	test("3. a running turn draws Esc stop", () => {
		expect(failing((c) => !/running|Running/.test(c.row) || c.footer.includes("Esc stop"))).toEqual(
			MAIN_FAILS.stop,
		);
	});

	test("4. a failed or loading judge draws judge and its value", () => {
		expect(
			failing(
				(c) =>
					(c.row !== "judgeFailed" || c.footer.includes("judge failed")) &&
					(c.row !== "judgeLoading" || c.footer.includes("judge loading")),
			),
		).toEqual(MAIN_FAILS.judge);
	});

	test("5. a flagged turn draws its words, not a bare mark, from 60 columns", () => {
		expect(failing((c) => c.row !== "flagged" || c.columns < 60 || /tests/.test(c.footer))).toEqual(
			MAIN_FAILS.flag,
		);
	});

	test("6. the meter is drawn at most once, and exactly once wherever main drew it", () => {
		expect(failing((c) => c.drawsCtx === /\bctx\b/.test(c.footer))).toEqual({});
		const drawn = (c: Case) => ctxCount(c.footer) + ctxCount(c.strip);
		// Twice only where the strip is the home because a running row cannot hold ctx,
		// and an idle footer still has room: the price of a meter that never moves (#308,
		// option A). Main drew it twice there too. Never twice mid-turn.
		const idleDup = (c: Case) => c.drawsCtx && !c.home && !/running|Running/.test(c.row);
		expect(failing((c) => drawn(c) <= 1 || idleDup(c))).toEqual({});
		expect(failing((c) => drawn(c) <= 1)).toEqual(IDLE_TWICE);
		// Where main drew it nowhere (no room in footer or strip; 30-56 and 90-91 columns
		// in most rows), it is drawn nowhere still: that set's digest, recorded on main.
		expect(sha(JSON.stringify(failing((c) => drawn(c) >= 1)))).toBe("0da21550daf205d3");
	});

	test("8. the meter keeps its place when a turn starts and ends", () => {
		// Same width, window and station; only the turn differs. The strip draws the
		// meter in both or in neither, so it never hops between the strip and the footer.
		const pairs = [
			["rich", "running"],
			["sandbox", "sandboxRunning"],
		] as const;
		const by = new Map(cases.map((c) => [c.name, c]));
		const twin = (c: Case) => {
			const pair = pairs.find(([idle]) => idle === c.row);
			return pair ? by.get(c.name.replace(` ${pair[0]} `, ` ${pair[1]} `)) : undefined;
		};
		const strip = (c: Case) => /\bctx\b/.test(c.strip);
		// The home never changes with the turn, at any width.
		expect(failing((c) => c.home === (twin(c)?.home ?? c.home))).toEqual({});
		// The strip draws it in one state only where the strip itself has no room for
		// it in the other ("finished 9:51 AM" against "read_file"), as on main.
		expect(failing((c) => !twin(c) || strip(c) === strip(twin(c) as Case))).toEqual(STRIP_ROOM);
		const footerCtx = (c: Case) => /\bctx\b/.test(c.footer);
		expect(
			failing((c) => {
				const t = twin(c);
				return !t || strip(c) === strip(t) || (!footerCtx(c) && !footerCtx(t));
			}),
			// Three single widths where the strip, the home, has no room idle ("finished
			// 9:51 AM"), so the idle footer carries it and the running strip takes it back.
			// Main moves it at the same widths.
		).toEqual({ "rich known": "56", "rich known station": "91", "sandbox known station": "91" });
	});

	test("7. the drawn footer row equals main's in every case", () => {
		// sha256 of every drawn footer row per row state, recorded on main (3d179b12).
		const MAIN: Record<string, string> = {
			rich: "c5891da249cd36bd",
			running: "07168efeb176d72e",
			sandbox: "d8e0b7b03a6a017e",
			sandboxRunning: "e06df15ec14e10ed",
			flagged: "12ea60df06ea24a9",
			bare: "f9f52f74023eeb3f",
			judgeFailed: "0a088428574ed68c",
			judgeLoading: "bb790c987d0dad29",
			held: "0ad9b83cc9558d87",
		};
		const got: Record<string, string> = {};
		for (const row of Object.keys(ROWS)) {
			const lines = cases.filter((c) => c.row === row).map((c) => `${c.name}|${c.footer}`);
			got[row] = sha(lines.join("\n"));
		}
		expect(cases.length).toBe(171 * 2 * 4 * 9);
		expect(got).toEqual(MAIN);
	});
});
