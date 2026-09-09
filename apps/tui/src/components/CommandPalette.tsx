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
 * Sizing: the palette never draws outside its own box. The caller passes
 * the usable column width and a row budget (see lib/layout popupLayout);
 * every line is truncated to the inner width with an ellipsis, so an entry
 * is always exactly one row.
 *
 * Layout:
 *   ╭────────────────────────────────╮
 *   │ » {query}                      │
 *   │ ──────────────────────────────  │
 *   │ ◆ /voice    voice settings...  │
 *   │ ○ /kanban   kanban toggle...   │
 *   │ ↑↓ move · Enter run · Esc close│
 *   ╰────────────────────────────────╯
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { padRight, truncate } from "../lib/text.js";
import { t } from "../theme.js";

export interface CommandPaletteCommand {
	name: string;
	description: string;
}

export interface CommandPaletteProps {
	isOpen: boolean;
	onClose: () => void;
	onExecute: (commandName: string) => void;
	commands: CommandPaletteCommand[];
	/** Total box width in columns, border included. Defaults to 50. */
	width?: number;
	/** Maximum command rows listed at once. Defaults to 10. */
	maxVisibleRows?: number;
}

export interface CommandPaletteViewProps {
	query: string;
	activeIndex: number;
	commands: CommandPaletteCommand[];
	/** Total box width in columns, border included. Defaults to 50. */
	width?: number;
	/** Maximum command rows listed at once. Defaults to 10. */
	maxVisibleRows?: number;
}

export const DEFAULT_PALETTE_WIDTH = 50;
export const DEFAULT_MAX_VISIBLE_ROWS = 10;
/** Widest the `/name` column will grow; longer names are truncated. */
const NAME_COL_MAX = 12;
/** Border (2) + paddingX (2). */
const BOX_CHROME_COLS = 4;
/** Marker glyph + space in front of every row. */
const MARKER_COLS = 2;
/** Below this many columns the description is dropped rather than mangled. */
const MIN_DESCRIPTION_COLS = 6;
const FOOTER = "↑↓ move · Enter run · Esc close";
const FILTER_PLACEHOLDER = "type to filter…";

/** True when `input` carries only printable characters (no control bytes). */
function isPrintable(input: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: filtering control bytes is the point
	return !/[\x00-\x1f\x7f]/.test(input);
}

/**
 * Compute a sliding window over the filtered command list that always
 * includes activeIndex. Returns the absolute start/end bounds plus the
 * sliced window so callers can derive realIndex = start + i.
 */
export function computeWindow(
	total: number,
	activeIndex: number,
	visible: number = DEFAULT_MAX_VISIBLE_ROWS,
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

/**
 * Column plan for a palette of `width` columns. Pure, so the row geometry
 * can be unit-tested without rendering.
 */
export function paletteColumns(
	width: number,
	commands: CommandPaletteCommand[],
): { inner: number; name: number; description: number } {
	const inner = Math.max(MARKER_COLS + 3, width - BOX_CHROME_COLS);
	const longestName = commands.reduce(
		(max, c) => Math.max(max, c.name.length + 1),
		0,
	);
	const name = Math.min(NAME_COL_MAX, longestName, inner - MARKER_COLS);
	// One space between the name column and the description.
	const description = Math.max(0, inner - MARKER_COLS - name - 1);
	return {
		inner,
		name,
		description: description < MIN_DESCRIPTION_COLS ? 0 : description,
	};
}

export function CommandPalette({
	isOpen,
	onClose,
	onExecute,
	commands,
	width = DEFAULT_PALETTE_WIDTH,
	maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
}: CommandPaletteProps): React.ReactElement | null {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);

	// Reset state whenever the palette opens.
	// react-doctor-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (isOpen) {
			setQuery("");
			setActiveIndex(0);
		}
	}, [isOpen]);

	const filtered = useMemo(
		() => filterAndSortCommands(commands, query),
		[commands, query],
	);

	// Clamp activeIndex if filter shrinks below current cursor.
	// react-doctor-disable-next-line react-doctor/no-effect-chain
	useEffect(() => {
		if (activeIndex >= filtered.length) {
			setActiveIndex(Math.max(0, filtered.length - 1));
		}
	}, [filtered.length, activeIndex]);

	useInput(
		(input, key) => {
			if (key.escape) {
				onClose();
				return;
			}
			if (key.return) {
				const active = filtered[activeIndex];
				if (active) {
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
				setActiveIndex((i) =>
					Math.min(Math.max(0, filtered.length - 1), i + 1),
				);
				return;
			}
			if (key.backspace || key.delete) {
				setQuery((q) => q.slice(0, -1));
				return;
			}
			// Ctrl+U clears the filter, mirroring the chat input.
			if (key.ctrl && input === "u") {
				setQuery("");
				return;
			}
			// Printable text (no ctrl/meta, no control bytes) appends to the
			// query. Fast typing and pastes arrive as multi-character chunks,
			// so the length is not restricted to one.
			if (input && !key.ctrl && !key.meta && isPrintable(input)) {
				setQuery((q) => q + input);
			}
		},
		{ isActive: isOpen },
	);

	if (!isOpen) {
		return null;
	}

	return (
		<CommandPaletteView
			query={query}
			activeIndex={activeIndex}
			commands={filtered}
			width={width}
			maxVisibleRows={maxVisibleRows}
		/>
	);
}

/**
 * Stateless render - easy to invoke directly in tests.
 */
export function CommandPaletteView({
	query,
	activeIndex,
	commands,
	width = DEFAULT_PALETTE_WIDTH,
	maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
}: CommandPaletteViewProps): React.ReactElement {
	const total = commands.length;
	const { start, end } = computeWindow(total, activeIndex, maxVisibleRows);
	const visible = commands.slice(start, end);
	const hiddenAbove = start;
	const hiddenBelow = total - end;
	const cols = paletteColumns(width, commands);
	const queryCols = Math.max(0, cols.inner - MARKER_COLS);

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			width={width}
			flexShrink={0}
			overflow="hidden"
		>
			<Box>
				<Text color={t.orange}>» </Text>
				{query ? (
					<Text color={t.cream}>{truncate(query, queryCols)}</Text>
				) : (
					<Text color={t.dim}>{truncate(FILTER_PLACEHOLDER, queryCols)}</Text>
				)}
			</Box>
			<Box>
				<Text color={t.border}>{"─".repeat(cols.inner)}</Text>
			</Box>
			{hiddenAbove > 0 ? (
				<Box>
					<Text color={t.dim}>{truncate(`  ↑ ${hiddenAbove} more`, cols.inner)}</Text>
				</Box>
			) : null}
			{visible.length === 0 ? (
				<Box>
					<Text color={t.dim}>no matches</Text>
				</Box>
			) : (
				visible.map((cmd, i) => {
					const realIndex = start + i;
					const active = realIndex === activeIndex;
					return (
						<Box key={`${realIndex}-${cmd.name}`}>
							<Text color={active ? t.orange : t.textTertiary}>
								{active ? "◆ " : "○ "}
							</Text>
							<Text color={active ? t.orange : t.textPrimary} bold={active}>
								{padRight(truncate(`/${cmd.name}`, cols.name), cols.name)}
							</Text>
							{cols.description > 0 ? (
								<Text color={active ? t.textPrimary : t.textSecondary}>
									{` ${truncate(cmd.description, cols.description)}`}
								</Text>
							) : null}
						</Box>
					);
				})
			)}
			{hiddenBelow > 0 ? (
				<Box>
					<Text color={t.dim}>{truncate(`  ↓ ${hiddenBelow} more`, cols.inner)}</Text>
				</Box>
			) : null}
			<Box>
				<Text color={t.dim}>{truncate(FOOTER, cols.inner)}</Text>
			</Box>
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
	const q = query.toLowerCase();
	if (!q) return commands;
	const matches = commands.filter((c) =>
		`${c.name} ${c.description}`.toLowerCase().includes(q),
	);
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
