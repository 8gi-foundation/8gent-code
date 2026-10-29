/**
 * CommandPalette - Ctrl+P overlay listing all slash commands.
 *
 * Composed of two pieces:
 *   - CommandPalette: stateful container that owns query / activeIndex /
 *     useInput. Returns null when isOpen=false.
 *   - CommandPaletteView: pure presentational component, easy to snapshot.
 *
 * Theme tokens only, no inline hex.
 *
 * Layout:
 *   ┌─ COMMANDS ─────────────────────┐
 *   │ » {query}                      │
 *   │ ──────────────                  │
 *   │ ◆ /voice    voice settings...  │
 *   │   /kanban   kanban toggle...   │
 *   └────────────────────────────────┘
 */

import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { chromeRows } from "../lib/chat-layout.js";
import { type ClickSpan, useClickSpans, usePressedIn } from "../lib/click-targets.js";
import { SETTLE_HOLD_MS, motionEnabled } from "../lib/motion.js";
import { glyphs } from "../lib/term-caps.js";
import { t } from "../theme.js";
import { type CapSpec, KeyCapRow } from "./KeyCap.js";

export interface CommandPaletteCommand {
	name: string;
	description: string;
}

export interface CommandPaletteProps {
	isOpen: boolean;
	/** Columns to fit the sheet into; defaults to the terminal's. */
	columns?: number;
	/** Rows on screen; the sheet fits the ones the shell's chrome leaves. Defaults to the terminal's. */
	rows?: number;
	/** False (Ctrl+A) skips the 120 ms press hold. */
	animate?: boolean;
	onClose: () => void;
	onExecute: (commandName: string) => void;
	commands: CommandPaletteCommand[];
}

export interface CommandPaletteViewProps {
	query: string;
	activeIndex: number;
	commands: CommandPaletteCommand[];
	/** Columns of the terminal. The sheet fits inside it; default 80. */
	columns?: number;
	/** Rows of the terminal; omitted, the sheet is not sized to the height. */
	rows?: number;
	/** A row held in its pressed look for the tap's 120 ms (index into `commands`). */
	pressedIndex?: number | null;
}

/** The widest the sheet gets, however wide the screen. */
export const PALETTE_MAX_WIDTH = 84;
/** Below this many columns a command is two lines and the sheet shows five. */
export const PALETTE_NARROW_COLS = 60;
const MAX_VISIBLE_ROWS = 10;
const NARROW_VISIBLE_ROWS = 5;
const NAME_COL_WIDTH = 12;
/** Border and padding each side: the sheet's text is this many cells narrower. */
const CHROME_COLS = 4;

/** The sheet's width: the screen less two columns, never past PALETTE_MAX_WIDTH. */
export function paletteWidth(columns: number): number {
	return Math.max(CHROME_COLS + 10, Math.min(columns - 2, PALETTE_MAX_WIDTH));
}

export interface PaletteGeometry {
	width: number;
	/** Cells of text inside the border and padding. */
	inner: number;
	narrow: boolean;
	/** Terminal lines one command takes. */
	rowHeight: number;
	visibleRows: number;
}

/** Most visible rows, fewest the sheet shrinks to. */
const MIN_VISIBLE_ROWS = 2;

/**
 * Sheet lines that are not commands: two borders, query, key caps, both "n more"
 * lines (counted always so the window never jumps), and from 60 columns the
 * rule and the legend.
 */
const FIXED_SHEET_ROWS = 6;
const WIDE_EXTRA_ROWS = 2;
/** A phone shows its place ("1-4/92") on the query line, so the two "n more" lines are not reserved. */
const NARROW_FIXED_SHEET_ROWS = 4;

export function paletteGeometry(columns: number, rows?: number): PaletteGeometry {
	const narrow = columns < PALETTE_NARROW_COLS;
	const width = paletteWidth(columns);
	const rowHeight = narrow ? 2 : 1;
	const most = narrow ? NARROW_VISIBLE_ROWS : MAX_VISIBLE_ROWS;
	// The sheet fits the rows the shell's chrome leaves, close key and count included (#5034).
	const fit =
		rows === undefined
			? most
			: Math.floor(
					(rows -
						chromeRows(rows, columns) -
						(narrow ? NARROW_FIXED_SHEET_ROWS : FIXED_SHEET_ROWS + WIDE_EXTRA_ROWS)) /
						rowHeight,
				);
	return {
		width,
		inner: width - CHROME_COLS,
		narrow,
		rowHeight,
		visibleRows: Math.max(MIN_VISIBLE_ROWS, Math.min(most, fit)),
	};
}

/**
 * The tap target of each visible row, in cells from the sheet's top-left:
 * border, query line and rule come first, then the "n more" line when rows
 * are hidden above. A row is its whole height wide as the sheet's text, so
 * a phone row is two lines tall.
 */
export function paletteRowSpans(
	columns: number,
	total: number,
	activeIndex: number,
	rows?: number,
): Array<{ index: number; dx: number; dy: number; w: number; h: number }> {
	const g = paletteGeometry(columns, rows);
	const { start, end } = computeWindow(total, activeIndex, g.visibleRows);
	// Border, query line, and (from 60 columns) the rule; a phone has no rule: every line counts.
	const top = g.narrow ? 2 : 3 + (start > 0 ? 1 : 0);
	const out = [];
	for (let i = start; i < end; i++) {
		out.push({ index: i, dx: 2, dy: top + (i - start) * g.rowHeight, w: g.inner, h: g.rowHeight });
	}
	return out;
}

/**
 * Compute a sliding window over the filtered command list that always
 * includes activeIndex. Returns the absolute start/end bounds plus the
 * sliced window so callers can derive realIndex = start + i.
 */
export function computeWindow(
	total: number,
	activeIndex: number,
	visible: number = MAX_VISIBLE_ROWS,
): { start: number; end: number } {
	if (total <= visible) {
		return { start: 0, end: total };
	}
	const half = Math.floor(visible / 2);
	const rawStart = activeIndex - half;
	const start = Math.max(0, Math.min(rawStart, total - visible));
	const end = Math.min(total, start + visible);
	return { start, end };
}

export function CommandPalette({
	isOpen,
	onClose,
	onExecute,
	commands,
	columns: columnsProp,
	rows: rowsProp,
	animate = true,
}: CommandPaletteProps): React.ReactElement | null {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [pressedIndex, setPressedIndex] = useState<number | null>(null);
	const { stdout } = useStdout();
	const columns = columnsProp ?? stdout?.columns ?? 80;
	const rows = rowsProp ?? stdout?.rows;

	// Reset state whenever the palette opens.
	// react-doctor-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (isOpen) {
			setQuery("");
			setActiveIndex(0);
		}
	}, [isOpen]);

	const filtered = useMemo(() => filterAndSortCommands(commands, query), [commands, query]);

	// Clamp activeIndex if filter shrinks below current cursor.
	// react-doctor-disable-next-line react-doctor/no-effect-chain
	useEffect(() => {
		if (activeIndex >= filtered.length) {
			setActiveIndex(Math.max(0, filtered.length - 1));
		}
	}, [filtered.length, activeIndex]);

	// A tap holds its row for SETTLE_HOLD_MS (the same hold as a pressed key
	// cap), then closes and runs in Enter's order. One timer at most. While it
	// is pending, Enter runs the held command at once (exactly once) and Esc
	// cancels it, so no key can run it twice or after a close. It is cleared
	// when the sheet closes or unmounts; reduced motion runs at once.
	const hold = useRef<{ timer: ReturnType<typeof setTimeout>; name: string } | null>(null);
	const clearHold = () => {
		if (hold.current) clearTimeout(hold.current.timer);
		hold.current = null;
		setPressedIndex(null);
	};
	useEffect(() => {
		if (!isOpen) clearHold();
	}, [isOpen]);
	useEffect(
		() => () => {
			if (hold.current) clearTimeout(hold.current.timer);
			hold.current = null;
		},
		[],
	);

	useInput(
		(input, key) => {
			if (key.escape) {
				clearHold();
				onClose();
				return;
			}
			if (key.return) {
				// A held tap wins: Enter during the hold runs that command now.
				const active = hold.current ? { name: hold.current.name } : filtered[activeIndex];
				if (active) {
					clearHold();
					// Close FIRST so this palette's useInput unmounts before
					// any sub-flow (e.g. /resume, /voice, /model menus) mounts
					// its own useInput. Otherwise both handlers race on the
					// next keypress. See issue #2388.
					onClose();
					onExecute(active.name);
				}
				return;
			}
			if (key.upArrow) {
				setActiveIndex((i) => Math.max(0, i - 1));
				return;
			}
			if (key.downArrow) {
				setActiveIndex((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
				return;
			}
			// A page is the rows on screen, so one press moves the whole window: with
			// 90+ commands, Down alone is ~90 presses to the end.
			if (key.pageUp || key.pageDown) {
				const page = paletteGeometry(columns, rows).visibleRows;
				setActiveIndex((i) =>
					key.pageDown
						? Math.min(Math.max(0, filtered.length - 1), i + page)
						: Math.max(0, i - page),
				);
				return;
			}
			if (key.backspace || key.delete) {
				setQuery((q) => q.slice(0, -1));
				return;
			}
			// Plain printable char (no ctrl/meta) appends to query.
			if (input && !key.ctrl && !key.meta && input.length === 1) {
				setQuery((q) => q + input);
			}
		},
		{ isActive: isOpen },
	);

	const tap = (index: number) => {
		const cmd = filtered[index];
		if (!cmd || hold.current) return;
		const run = () => {
			clearHold();
			onClose();
			onExecute(cmd.name);
		};
		setActiveIndex(index);
		if (!motionEnabled(animate)) return run();
		setPressedIndex(index);
		hold.current = { timer: setTimeout(run, SETTLE_HOLD_MS), name: cmd.name };
	};
	const sheetRef = useRef(null);
	const spans: ClickSpan[] = isOpen
		? paletteRowSpans(columns, filtered.length, activeIndex, rows).map((r) => ({
				id: `palette:row:${r.index}`,
				dx: r.dx,
				dy: r.dy,
				w: r.w,
				h: r.h,
				action: () => tap(r.index),
			}))
		: [];
	// z above the chat's own targets: the sheet sits over them.
	useClickSpans(sheetRef, spans, 10);
	const pressedId = usePressedIn("palette:row:");
	const pressedByMouse = pressedId ? Number(pressedId.slice("palette:row:".length)) : null;

	if (!isOpen) {
		return null;
	}

	return (
		<Box ref={sheetRef} flexShrink={0}>
			<CommandPaletteView
				query={query}
				activeIndex={activeIndex}
				commands={filtered}
				columns={columns}
				rows={rows}
				pressedIndex={pressedIndex ?? pressedByMouse}
			/>
		</Box>
	);
}

/**
 * Stateless render - easy to invoke directly in tests.
 */
export function CommandPaletteView({
	query,
	activeIndex,
	commands,
	columns = 80,
	rows,
	pressedIndex = null,
}: CommandPaletteViewProps): React.ReactElement {
	const g = paletteGeometry(columns, rows);
	const gl = glyphs();
	const ascii = gl.rule === "-";
	const arrowUp = ascii ? "^" : "↑";
	const arrowDown = ascii ? "v" : "↓";
	const total = commands.length;
	const { start, end } = computeWindow(total, activeIndex, g.visibleRows);
	const visible = commands.slice(start, end);
	const hiddenAbove = start;
	const hiddenBelow = total - end;
	const caps: CapSpec[] = [
		{ cap: "↑↓", verb: "move" },
		{ cap: "Enter", verb: "run" },
		{ cap: "Esc", verb: "close" },
	].map((c, i) => (g.narrow && i > 0 ? { ...c, gap: 1 } : c));

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			width={g.width}
			flexShrink={0}
		>
			<Box>
				<Text color={t.orange}>» </Text>
				<Text color={t.cream}>{query || ""}</Text>
				<Text color={t.textTertiary}>{query ? "" : "type to filter…"}</Text>
				{g.narrow && total > 0 ? (
					<>
						<Box flexGrow={1} />
						<Text color={t.textTertiary}>{`${start + 1}-${end}/${total}`}</Text>
					</>
				) : null}
			</Box>
			{g.narrow ? null : (
				<Box>
					<Text color={t.border}>{gl.rule.repeat(g.inner)}</Text>
				</Box>
			)}
			{hiddenAbove > 0 && !g.narrow ? (
				<Box>
					<Text color={t.textTertiary}>
						{"  "}
						{arrowUp} {hiddenAbove} more{" \u00b7 PgUp"}
					</Text>
				</Box>
			) : null}
			{visible.length === 0 ? (
				<Box>
					<Text color={t.textTertiary}>no matches</Text>
				</Box>
			) : (
				visible.map((cmd, i) => {
					const realIndex = start + i;
					// Selected, or held by a tap: the one orange row.
					const active = realIndex === activeIndex || realIndex === pressedIndex;
					// Marker and its space are a fixed two-cell gutter that never shrinks.
					const marker = (
						<Box key="marker" width={2} flexShrink={0}>
							<Text color={active ? t.orange : t.textTertiary}>
								{active ? gl.diamond : gl.pending}{" "}
							</Text>
						</Box>
					);
					const nameText = (
						<Text
							key="nametext"
							color={active ? t.orange : t.textPrimary}
							bold={active}
							wrap="truncate-end"
						>
							{g.narrow ? `/${cmd.name}` : padRight(`/${cmd.name}`, NAME_COL_WIDTH)}
						</Text>
					);
					// Wide: a fixed-width name cell that never shrinks, so a long description
					// cannot squeeze the name and pull its own column left.
					const name = g.narrow ? (
						<Box key="name">{nameText}</Box>
					) : (
						<Box key="name" width={NAME_COL_WIDTH} flexShrink={0}>
							{nameText}
						</Box>
					);
					const desc = (
						<Text key="desc" color={active ? t.textPrimary : t.textSecondary} wrap="truncate-end">
							{cmd.description}
						</Text>
					);
					return g.narrow ? (
						<Box key={`${realIndex}-${cmd.name}`} flexDirection="column">
							<Box>
								{marker}
								{name}
							</Box>
							<Box>
								<Box width={2} flexShrink={0} />
								<Box flexShrink={1} minWidth={0}>
									{desc}
								</Box>
							</Box>
						</Box>
					) : (
						<Box key={`${realIndex}-${cmd.name}`}>
							{marker}
							{name}
							<Text color={t.muted}> </Text>
							<Box flexShrink={1} minWidth={0}>
								{desc}
							</Box>
						</Box>
					);
				})
			)}
			{hiddenBelow > 0 && !g.narrow ? (
				<Box>
					<Text color={t.textTertiary}>
						{"  "}
						{arrowDown} {hiddenBelow} more{" \u00b7 PgDn"}
					</Text>
				</Box>
			) : null}
			<Box>
				<KeyCapRow caps={caps} idPrefix="palette" z={20} />
			</Box>
			{g.narrow ? null : (
				<Box>
					{/* The modifier legend, once, where every command is listed (#3238). */}
					<Text color={t.textTertiary}>^ Ctrl ⇧ Shift</Text>
				</Box>
			)}
		</Box>
	);
}

/**
 * Filter commands case-insensitively against `name + " " + description`,
 * then sort: exact name prefix matches first, then substring matches.
 * Stable order within each bucket follows the input order.
 */
export function filterAndSortCommands(
	commands: CommandPaletteCommand[],
	query: string,
): CommandPaletteCommand[] {
	// Every row is shown as "/name", so people type the slash too: it is not part of the name.
	const q = query.toLowerCase().replace(/^\/+/, "");
	if (!q) return commands;
	const matches = commands.filter((c) => `${c.name} ${c.description}`.toLowerCase().includes(q));
	const prefix: CommandPaletteCommand[] = [];
	const rest: CommandPaletteCommand[] = [];
	for (const c of matches) {
		if (c.name.toLowerCase().startsWith(q)) {
			prefix.push(c);
		} else {
			rest.push(c);
		}
	}
	return [...prefix, ...rest];
}

function padRight(s: string, width: number): string {
	if (s.length >= width) return s;
	return s + " ".repeat(width - s.length);
}
