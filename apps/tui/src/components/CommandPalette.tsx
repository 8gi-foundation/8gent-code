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

import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";
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
}

export interface CommandPaletteViewProps {
	query: string;
	activeIndex: number;
	commands: CommandPaletteCommand[];
}

const PALETTE_WIDTH = 50;
const MAX_VISIBLE_ROWS = 10;
const NAME_COL_WIDTH = 12;

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
			// Plain printable char (no ctrl/meta) appends to query.
			if (input && !key.ctrl && !key.meta && input.length === 1) {
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
}: CommandPaletteViewProps): React.ReactElement {
	const total = commands.length;
	const { start, end } = computeWindow(total, activeIndex, MAX_VISIBLE_ROWS);
	const visible = commands.slice(start, end);
	const hiddenAbove = start;
	const hiddenBelow = total - end;

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			width={PALETTE_WIDTH}
			flexShrink={0}
		>
			<Box>
				<Text color={t.orange}>» </Text>
				<Text color={t.cream}>{query || ""}</Text>
				<Text color={t.dim}>{query ? "" : "type to filter…"}</Text>
			</Box>
			<Box>
				<Text color={t.border}>──────────────────────────────────────────</Text>
			</Box>
			{hiddenAbove > 0 ? (
				<Box>
					<Text color={t.dim}>  ↑ {hiddenAbove} more</Text>
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
								{padRight(`/${cmd.name}`, NAME_COL_WIDTH)}
							</Text>
							<Text color={t.muted}> </Text>
							<Text color={active ? t.textPrimary : t.textSecondary} wrap="truncate-end">
								{cmd.description}
							</Text>
						</Box>
					);
				})
			)}
			{hiddenBelow > 0 ? (
				<Box>
					<Text color={t.dim}>  ↓ {hiddenBelow} more</Text>
				</Box>
			) : null}
			<Box>
				<Text color={t.dim}>↑↓ move · Enter run · Esc close</Text>
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

function padRight(s: string, width: number): string {
	if (s.length >= width) return s;
	return s + " ".repeat(width - s.length);
}
