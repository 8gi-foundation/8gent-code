import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { LiveFocalStrip } from "../LiveFocalStrip.js";
import {
	FOOTER_METER_COLS,
	type FooterData,
	buildFooterSegments,
	fitFooterRow,
} from "../StatusFooter.js";

/**
 * The NOW strip stopped drawing the context meter (#9), so the footer must be
 * its home at every width and in every state: a person never loses sight of
 * how full the window is. Swept from FOOTER_METER_COLS (48, below which the [^P]
 * palette cap wins the row) up to 200.
 */
const MIN_COLUMNS = FOOTER_METER_COLS;
const MAX_COLUMNS = 200;
// From here the mode, perm, meter, a sandbox flag and the [^P] cap all fit together even on
// the busiest row. Between FOOTER_METER_COLS and here the busiest rows keep the meter and
// every state, and the cap (Ctrl+P still works) is what gives way.
const CAP_COLUMNS = 70;

const windows = {
	"known window": { used: 24_700, window: 32_800, stale: false },
	"unknown window": { used: 24_700, window: null, stale: false },
	"window nearly full": { used: 125_000, window: 131_072, stale: false },
	"stale after compaction": { used: null, window: 32_800, stale: true },
};

const rows: Record<string, Partial<FooterData>> = {
	"rich idle row": {
		permissions: "infinite",
		localChip: "92% local today",
		daemonAttached: true,
		traceHint: "open",
		user: "james",
		sessionTime: "8m 12s",
		providersLive: 1,
		providersTotal: 3,
		tokensPerSecond: 42,
		adhd: true,
		durable: true,
	},
	"turn running": {
		permissions: "infinite",
		localChip: "92% local today",
		turnRunning: true,
		turnCalls: 12,
		daemonAttached: true,
		traceHint: "fold",
		user: "james",
		sessionTime: "8m 12s",
	},
	"sandbox off": {
		permissions: "guarded",
		localChip: "92% local today",
		sandboxOff: "nested",
		user: "james",
		sessionTime: "8m 12s",
	},
	"sandbox off and running": {
		permissions: "infinite",
		localChip: "92% local today",
		sandboxOff: "no bwrap",
		turnRunning: true,
		turnCalls: 12,
		thinking: "high",
	},
	"flagged turn": {
		permissions: "infinite",
		localChip: "92% local today",
		verification: "tests_claimed_not_run",
		thinking: "auto",
		user: "james",
	},
	"bare row": {},
};

describe("the footer always keeps the ctx meter, and nothing else draws it", () => {
	for (const [windowName, ctx] of Object.entries(windows)) {
		for (const [rowName, row] of Object.entries(rows)) {
			test(`${windowName}, ${rowName}: ctx present from ${MIN_COLUMNS} to ${MAX_COLUMNS} columns`, () => {
				const missing: number[] = [];
				const capLost: number[] = [];
				for (let columns = MIN_COLUMNS; columns <= MAX_COLUMNS; columns++) {
					const segments = buildFooterSegments({ mode: "Planning", ...row, ctx, columns });
					const fitted = fitFooterRow(segments, columns);
					const n = fitted.segments.filter((s) => s.key === "ctx").length;
					if (n !== 1) missing.push(columns);
					// The meter does not win by pushing out the way into the commands.
					if (columns >= CAP_COLUMNS && fitted.hints[0] !== "^P palette") capLost.push(columns);
				}
				expect(missing).toEqual([]);
				expect(capLost).toEqual([]);
			});
		}
	}

	test("the strip draws no meter at any width, so the footer is the one place", () => {
		const drawn: number[] = [];
		for (let columns = MIN_COLUMNS; columns <= MAX_COLUMNS; columns += 4) {
			const out = renderToString(
				<LiveFocalStrip
					mode="Planning"
					activeStep="DONE"
					route="qwen3.5:9b-32k"
					tokens="71K tok"
					contextPct={75}
					lastTurnEndedAt={Date.now() - 60_000}
					lastTurnSuccess={true}
					animate={false}
					width={columns}
				/>,
				{ columns },
			);
			if (out.includes("ctx") || out.includes("█")) drawn.push(columns);
		}
		expect(drawn).toEqual([]);
	});
});
