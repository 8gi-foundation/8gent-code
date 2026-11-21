/**
 * #9, design read on #308: the ctx meter keeps its place when a turn starts.
 * At 80 to 88 columns `Esc stop` pushes ctx out of the running footer row. The
 * meter's home is decided from that mid-turn row, so it sits in the NOW strip
 * idle and running alike, instead of hopping from the footer to the strip and
 * back at every turn. Wired as app.tsx wires it: the footer reports through
 * onCtxShown and the strip draws the meter when the footer is not its home.
 */
import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Box, renderToString } from "ink";
import React from "react";
import stringWidth from "string-width";
import { chatColumnWidth } from "../../lib/chat-layout.js";
import { LiveFocalStrip } from "../LiveFocalStrip.js";
import { type FooterData, StatusSegments } from "../StatusFooter.js";

const ctx = { used: 24700, window: 32768, stale: false };
const rich: Partial<FooterData> = {
	permissions: "guarded",
	localChip: "92% local today",
	sessionTime: "8m 12s",
	daemonAttached: true,
	user: "sam",
	thinking: "auto",
};
const plain = (s: string) => stripVTControlCharacters(s).replace(/\n+$/, "");

/** The footer and the NOW strip at one width and turn state, wired as in app.tsx. */
function frame(columns: number, running: boolean) {
	const width = columns - 1;
	const data: FooterData = {
		mode: "Planning",
		columns,
		ctx,
		...rich,
		...(running ? { turnRunning: true, turnCalls: 12 } : {}),
	};
	let home: boolean | null = null;
	const footer = plain(
		renderToString(
			<Box width={width + 1}>
				<StatusSegments
					data={data}
					width={width}
					onCtxShown={(shown) => {
						home = shown;
					}}
				/>
			</Box>,
			{ columns: width + 1 },
		),
	).trimEnd();
	if (home === null) throw new Error("the footer never reported the meter's home");
	const sw = chatColumnWidth(columns, { activity: columns >= 90 });
	const strip = plain(
		renderToString(
			<LiveFocalStrip
				mode="Planning"
				activeStep={running ? "read_file" : "idle"}
				route="qwen3.5:9b-32k"
				tokens="71K tok"
				contextPct={75}
				contextState="server"
				meter={!home}
				isProcessing={running}
				lastTurnEndedAt={running ? null : Date.now() - 60_000}
				lastTurnSuccess={running ? null : true}
				animate={false}
				width={sw}
			/>,
			{ columns: sw },
		),
	);
	return { footer, strip, width, sw };
}

const has = (s: string) => /\bctx\b/.test(s);

describe("the ctx meter keeps its place from idle to mid-turn (#9)", () => {
	for (const columns of [80, 84, 88]) {
		test(`${columns} columns: the strip draws the meter idle and running`, () => {
			const idle = frame(columns, false);
			const run = frame(columns, true);
			// The running footer has no room for ctx at this width.
			expect(has(run.footer)).toBe(false);
			// So the strip is the meter's home in both states: it never hops.
			expect({ idle: has(idle.strip), running: has(run.strip) }).toEqual({
				idle: true,
				running: true,
			});
			for (const f of [idle, run]) {
				expect(stringWidth(f.footer)).toBeLessThanOrEqual(f.width);
				for (const l of f.strip.split("\n")) expect(stringWidth(l)).toBeLessThanOrEqual(f.sw);
			}
		});
	}

	test("100 columns: the footer holds it throughout, drawn at most once", () => {
		for (const running of [false, true]) {
			const f = frame(100, running);
			expect(has(f.footer)).toBe(true);
			expect(has(f.strip)).toBe(false);
			expect((`${f.strip}\n${f.footer}`.match(/\bctx\b/g) ?? []).length).toBeLessThanOrEqual(1);
		}
	});
});
