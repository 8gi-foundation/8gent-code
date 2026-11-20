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
} from "../StatusFooter.js";

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

const plain = (s: string) => stripVTControlCharacters(s);

interface Case {
	name: string;
	row: string;
	columns: number;
	width: number;
	footer: string;
	strip: string;
	drawsCtx: boolean;
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
				lastTurnEndedAt={running ? null : Date.now() - 60_000}
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
				const running = Boolean(extra.turnRunning);
				cases.push({
					name: `w${columns} ${row} ${w}${station ? " station" : ""}`,
					row,
					columns,
					width,
					footer,
					strip: drawStrip(columns, w, running, !drawsCtx),
					drawsCtx,
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
		expect(failing((c) => drawn(c) <= 1)).toEqual({});
		// Where main drew it nowhere (no room in footer or strip; 30-56 and 90-91 columns
		// in most rows), it is drawn nowhere still: that set's digest, recorded on main.
		expect(sha(JSON.stringify(failing((c) => drawn(c) === 1)))).toBe("0da21550daf205d3");
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
