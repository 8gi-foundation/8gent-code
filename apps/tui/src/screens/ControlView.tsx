/**
 * Control tab (#5062, slice 1 of #5067): every loop, its state, last run, next
 * run and what it waits on, in one read-only screen.
 *
 * Lazy by construction: the store is only subscribed while this view is
 * mounted, and the App mounts it only for the active Control tab. Closed, it
 * renders nothing and reads nothing. Enter opens a row's detail; p, r and t
 * only say the actions are not available yet. No action is wired.
 */
import { Box, Text, useInput, useStdout } from "ink";
import React, { useMemo, useState } from "react";
import { useControlSnapshot } from "../hooks/useControlSnapshot.js";
import { type LoopRow, type LoopState, STATE_ORDER } from "../lib/control-state.js";
import type { MachineHeader } from "../lib/control-store.js";
import { t } from "../theme.js";

interface ControlViewProps {
	visible: boolean;
	onClose: () => void;
}

const GROUP: Record<LoopState, { glyph: string; title: string; color: string }> = {
	"waiting-on-you": { glyph: "!", title: "WAITING ON YOU", color: t.orange },
	running: { glyph: "●", title: "RUNNING", color: t.green },
	queued: { glyph: "◐", title: "QUEUED / GATED", color: t.teal },
	stalled: { glyph: "○", title: "STALLED", color: t.red },
	done: { glyph: "●", title: "DONE", color: t.textTertiary },
};

export function headerLine(h: MachineHeader): string {
	const disk =
		h.freeDiskGB === null
			? "disk ?"
			: `disk ${h.freeDiskGB}G${h.diskFloorGB !== null ? ` floor ${h.diskFloorGB}` : ""}`;
	const helpers = h.helperCap !== null ? `${h.helpers}/${h.helperCap}` : String(h.helpers);
	return `load ${h.load}  ${disk}  helpers ${helpers}`;
}

/** Rows in display order: groups by urgency; `done` rows are counted, not listed. */
export function groupRows(rows: readonly LoopRow[]): {
	groups: { state: LoopState; rows: LoopRow[] }[];
	flat: LoopRow[];
	done: number;
} {
	const groups = STATE_ORDER.map((state) => ({
		state,
		rows: rows.filter((r) => r.state === state),
	})).filter((g) => g.rows.length > 0);
	return {
		groups,
		flat: groups.flatMap((g) => g.rows),
		done: rows.filter((r) => r.state === "done").length,
	};
}

function pad(s: string, n: number): string {
	if (s.length <= n) return s + " ".repeat(n - s.length);
	// A cut is shown, never silent: the last cell is an ellipsis.
	return n > 1 ? `${s.slice(0, n - 1)}…` : s.slice(0, n);
}

/** Widest value in a column, so a column only cuts when the row truly cannot fit it. */
function widest(values: readonly string[]): number {
	return values.reduce((m, v) => Math.max(m, v.length), 0);
}

export function ControlView({ visible, onClose }: ControlViewProps) {
	const snap = useControlSnapshot(visible, { header: true });
	const { stdout } = useStdout();
	const cols = stdout?.columns ?? 80;
	const [sel, setSel] = useState(0);
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const grouped = useMemo(() => groupRows(snap?.rows ?? []), [snap]);
	const selected = grouped.flat[Math.min(sel, Math.max(0, grouped.flat.length - 1))];

	useInput(
		(input, key) => {
			if (key.escape || input === "q") {
				if (open) setOpen(false);
				else onClose();
				return;
			}
			if (key.upArrow) setSel((i) => Math.max(0, i - 1));
			else if (key.downArrow) setSel((i) => Math.min(Math.max(0, grouped.flat.length - 1), i + 1));
			else if (key.return && selected) setOpen((o) => !o);
			else if (input === "p" || input === "r" || input === "t")
				setNote("Pause, resume and try again are not available yet.");
		},
		{ isActive: visible },
	);

	if (!visible) return null;
	if (!snap) return <Text color={t.textTertiary}>CONTROL reading...</Text>;

	const narrow = cols < 60;
	const nextW = Math.min(12, Math.max(8, ...grouped.flat.map((r) => (r.next ?? "-").length)));
	// Rows: marker 2 + name + stage + last 6 (+ next) + gaps, inside 2 cells of padding.
	const fixed = 2 + 2 + 6 + (narrow ? 2 : 3 + nextW);
	const room = Math.max(20, cols - fixed);
	const nameWant = widest(grouped.flat.map((r) => r.name));
	const stageWant = widest(grouped.flat.map((r) => r.stage));
	// Narrow: the name keeps 12 cells and the stage gets the rest, as before; the cut is now marked.
	const nameW = narrow
		? Math.min(nameWant, 12)
		: Math.max(12, Math.min(nameWant, Math.floor(room * 0.55), 32));
	// Narrow: no next column; the reason moves to its own line so it is never cut away.
	const stageW = Math.max(8, Math.min(stageWant, room - nameW));
	let index = -1;

	return (
		<Box flexDirection="column" paddingX={1} flexGrow={1}>
			<Box flexShrink={0}>
				<Text color={t.heading} bold>
					CONTROL
				</Text>
				<Text color={t.textTertiary} wrap="truncate-end">
					{narrow
						? ` ${headerLine(snap.header).replace(/ {2,}/g, " ")}`
						: `   ${headerLine(snap.header)}`}
				</Text>
			</Box>
			{grouped.flat.length === 0 ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={t.textSecondary}>No loops reported yet.</Text>
					<Text color={t.textTertiary}>
						A loop reports itself by writing one JSON file into ~/.8gent/jobs. Point sources
						elsewhere in ~/.8gent/control.json.
					</Text>
				</Box>
			) : (
				grouped.groups.map((g) => (
					<Box key={g.state} flexDirection="column" marginTop={1} flexShrink={0}>
						<Text color={GROUP[g.state].color} bold>
							{`${GROUP[g.state].glyph}  ${GROUP[g.state].title}`}
						</Text>
						{g.rows.map((r) => {
							index += 1;
							const isSel = index === Math.min(sel, grouped.flat.length - 1);
							const why = r.waitingOn ? `waiting on ${r.waitingOn}` : "";
							const cells = narrow
								? `${pad(r.name, nameW)} ${pad(r.stage, stageW)} ${pad(r.last ?? "-", 6)}`
								: `${pad(r.name, nameW)} ${pad(r.stage, stageW)} ${pad(r.last ?? "-", 6)} ${pad(r.next ?? "-", nextW)}`;
							// The reason is why a human is needed: it gets its own line, uncut, when it cannot fit beside the cells.
							const inline = !why || (!narrow && 2 + cells.length + 1 + why.length <= cols - 2);
							return (
								<Box key={`${r.kind}:${r.name}`} flexDirection="column" flexShrink={0}>
									<Text color={isSel ? t.textPrimary : t.textSecondary} wrap="truncate-end">
										{`${isSel ? "▸" : " "} ${cells}${inline && why ? ` ${why}` : ""}`}
									</Text>
									{why && !inline ? (
										<Box paddingLeft={4} flexShrink={0}>
											<Text color={t.textSecondary}>{why}</Text>
										</Box>
									) : null}
									{isSel && open ? (
										<Box flexDirection="column" paddingLeft={4} flexShrink={0}>
											<Text color={t.textTertiary}>{`kind ${r.kind}   state ${r.state}`}</Text>
											<Text
												color={t.textTertiary}
											>{`last ${r.last ?? "-"}   next ${r.next ?? "-"}`}</Text>
											{r.waitingOn ? (
												<Text color={t.textSecondary}>{`waiting on ${r.waitingOn}`}</Text>
											) : null}
											{r.detail ? <Text color={t.textSecondary}>{r.detail}</Text> : null}
										</Box>
									) : null}
								</Box>
							);
						})}
					</Box>
				))
			)}
			{grouped.done > 0 ? (
				<Box marginTop={1} flexShrink={0}>
					<Text color={t.textTertiary}>{`${grouped.done} done, not listed`}</Text>
				</Box>
			) : null}
			{snap.problems.length > 0 ? (
				<Box flexShrink={0}>
					<Text color={t.textTertiary}>{`${snap.problems.length} source line(s) skipped`}</Text>
				</Box>
			) : null}
			<Box marginTop={1} flexShrink={0}>
				<Text color={t.textTertiary}>{note ?? "[enter] open  [esc] close"}</Text>
			</Box>
		</Box>
	);
}
