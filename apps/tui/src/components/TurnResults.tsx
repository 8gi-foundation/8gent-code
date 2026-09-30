/**
 * TurnResults - a finished turn's work as checked steps (mockup A's DONE block).
 *
 *   ✓ Wrote  deck/outline.md
 *   ✗ Ran  bun test  exit 1
 *   ✓ Read  packages/decide/  5 files
 *
 * Rows come from lib/turn-results.ts: the turn's real tool trail and the
 * plan the PLAN column held for the turn (the agent's own update_plan). Every row is pre-fitted to
 * `width`, so nothing wraps or pushes the column sideways.
 *
 * Motion: the rows land in order when the reply arrives, after the figure-8
 * in the NOW strip has settled into DONE (SETTLE_HOLD_MS), 80 ms apart and
 * within 300 ms in all. Ctrl+A or 8GENT_REDUCED_MOTION=1 draws them at once.
 * A turn scrolled back into view never replays.
 *
 * Colour goes through Ink props only. The chip is a background tint from the
 * theme (t.border), so chalk steps it down on 256 and 16 colour terminals;
 * the icons come from lib/term-caps.ts and fall back to ASCII there too.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { SETTLE_HOLD_MS, motionEnabled, staggerFor } from "../lib/motion.js";
import type { PlanStep } from "../lib/plan-state.js";
import { glyphs } from "../lib/term-caps.js";
import type { ToolTrailEntry } from "../lib/tool-trail.js";
import { type ResultStatus, buildTurnResults, fitResultRow } from "../lib/turn-results.js";
import { t } from "../theme.js";

function iconFor(status: ResultStatus): { icon: string; color: string } {
	const g = glyphs();
	if (status === "ok") return { icon: g.ok, color: t.green };
	if (status === "fail") return { icon: g.fail, color: t.red };
	if (status === "blocked") return { icon: g.blocked, color: t.textSecondary };
	return { icon: g.pending, color: t.muted };
}

/** How many of `total` rows to draw: all at once, or landing one by one. */
export function useResultLanding(total: number, land: boolean): number {
	const [shown, setShown] = useState(land ? 0 : total);
	useEffect(() => {
		if (!land) {
			setShown(total);
			return;
		}
		const step = Math.max(1, staggerFor(total));
		let n = 0;
		let interval: ReturnType<typeof setInterval> | null = null;
		const hold = setTimeout(() => {
			n = 1;
			setShown(Math.min(total, n));
			if (n >= total) return;
			interval = setInterval(() => {
				n += 1;
				setShown(Math.min(total, n));
				if (n >= total && interval) clearInterval(interval);
			}, step);
		}, SETTLE_HOLD_MS);
		return () => {
			clearTimeout(hold);
			if (interval) clearInterval(interval);
		};
		// Landing runs once, when the reply first mounts.
	}, []);
	return land ? Math.min(shown, total) : total;
}

export function TurnResults({
	trail,
	plan,
	width,
	maxRows,
	land = false,
	animate = true,
}: {
	trail: ToolTrailEntry[];
	/** The plan the PLAN column held for this turn; else the trail's update_plan. */
	plan?: ReadonlyArray<PlanStep>;
	width: number;
	/** Row ceiling; the oldest successful calls fold into one row. */
	maxRows?: number;
	/** True only the first time the reply mounts (a new turn result). */
	land?: boolean;
	/** False (Ctrl+A) draws every row at once. */
	animate?: boolean;
}) {
	const rows = buildTurnResults(trail, maxRows, plan);
	const visible = useResultLanding(rows.length, land && motionEnabled(animate));
	if (rows.length === 0) return null;
	// The block keeps its full height while rows land, so the reply below it
	// never jumps: rows not landed yet are blank lines of the same size.
	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.map((row, i) => {
				if (i >= visible) {
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					return <Box key={i} height={1} width={width} />;
				}
				const { icon, color } = iconFor(row.status);
				const fit = fitResultRow(row, width);
				const quiet = row.status === "pending" || row.kind === "fold";
				return (
					// Rows are positional within one finished turn and never reorder.
					// react-doctor-disable-next-line react-doctor/no-array-index-as-key
					<Box key={i} width={width} height={1}>
						<Text wrap="truncate-end">
							<Text color={color}>{icon}</Text>
							<Text> </Text>
							<Text bold={!quiet} color={quiet ? t.muted : t.textPrimary}>
								{fit.verb}
							</Text>
							{fit.text ? (
								<Text color={quiet ? t.muted : t.textSecondary}>{` ${fit.text}`}</Text>
							) : null}
							{fit.chip ? (
								<>
									<Text> </Text>
									<Text color={t.textPrimary} backgroundColor={t.border}>
										{` ${fit.chip} `}
									</Text>
								</>
							) : null}
							{fit.note ? (
								<Text
									color={row.status === "fail" ? t.red : t.muted}
								>{`${" ".repeat(fit.noteGap ?? 2)}${fit.note}`}</Text>
							) : null}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
