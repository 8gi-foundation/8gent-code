/**
 * 8gent Code - Select Input Component
 *
 * Scrollable selection menus for options like:
 * - Yes/No confirmations
 * - Model selection
 * - Provider selection
 * - Any list of choices
 *
 * Features:
 * - Arrow key navigation (up/down)
 * - Enter to select
 * - Escape to cancel
 * - Search/filter while typing
 * - Highlighted current selection
 */

import { Box, type TextProps, useInput, useStdout } from "ink";
import React, { useState, useEffect, useMemo } from "react";
import { providerRowNote } from "../lib/provider-order.js";
import { AppText, Heading, Label, MutedText } from "./primitives/AppText.js";
import { Card } from "./primitives/Card.js";
import { Inline } from "./primitives/Inline.js";
import { Stack } from "./primitives/Stack.js";

function clampScrollOffset(selectedIndex: number, total: number, maxVisible: number): number {
	if (total <= maxVisible) return 0;
	const maxScroll = total - maxVisible;
	let off = Math.max(0, selectedIndex - maxVisible + 1);
	off = Math.min(off, maxScroll);
	return off;
}

// ============================================
// Types
// ============================================

export interface SelectOption<T = string> {
	label: string;
	value: T;
	description?: string;
	disabled?: boolean;
	/** Drawn muted but still selectable: a choice that is known not to answer right now. */
	dim?: boolean;
	icon?: string;
	/** Hex colours drawn as a preview row before the label (theme picker). */
	swatches?: string[];
}

export interface SelectInputProps<T = string> {
	options: SelectOption<T>[];
	onSelect: (value: T) => void;
	onCancel?: () => void;
	title?: string;
	initialIndex?: number;
	maxVisible?: number;
	showDescription?: boolean;
	searchable?: boolean;
	highlightColor?: string;
	/** Added to the refusal line: another way to do the same thing. */
	refuseNote?: string;
}

/**
 * Rows the app draws around a picker (banner, tabs, NOW strip, frame, footer)
 * plus the picker's own border, title, hint and scroll lines. What is left is
 * how many option rows fit. A picker taller than the screen lost its bottom
 * border and the frame's corners landed inside the hint line (pilot break 11).
 */
export const PICKER_CHROME_ROWS = 23;
/** Under this many rows the picker drops its description and spacer rows. */
export const PICKER_COMPACT_BELOW_ROWS = 26;
/** Under this many columns the long hint (56 cells) no longer fits the card (columns minus 10), so the short form is used. */
export const PICKER_NARROW_COLUMNS = 66;

export function isCompactPicker(terminalRows: number | undefined): boolean {
	return !!terminalRows && terminalRows > 0 && terminalRows < PICKER_COMPACT_BELOW_ROWS;
}

/** The key hint, whole at any width: the short form keeps Cancel and the filter tip. */
export function pickerHint(columns: number | undefined, searchable: boolean): string {
	if (columns && columns < PICKER_NARROW_COLUMNS) {
		return searchable ? "↑↓ Enter Esc  type to filter" : "↑↓ Enter Esc";
	}
	return `[↑↓] Navigate [Enter] Select [Esc] Cancel${searchable ? " [type] Filter" : ""}`;
}
export const PICKER_MIN_VISIBLE = 3;
/**
 * Rows the app draws around a picker with the full chrome, measured in the real
 * app at 24 rows: banner 3, tab row 2, NOW strip 3, frame 2, Esc line 1, status
 * footer 1 = 12, inside a frame one row shorter than the terminal. So the picker
 * has terminal rows minus 13. (This was 11, which over-counted the room by two.)
 */
export const PICKER_APP_ROWS = 13;
/**
 * Short windows: while a picker is open the app hides the banner, tab row and NOW
 * strip. What stays is the frame 2, Esc line 1 and status footer 1, so the picker
 * has terminal rows minus 5.
 */
export const PICKER_SHORT_APP_ROWS = 5;
/**
 * Below this many rows the full chrome leaves no room for 3 rows inside a bordered
 * card (border 2, title 1, scroll line 1, hint 1), so the chrome is hidden instead.
 */
export const PICKER_SHORT_BELOW_ROWS = PICKER_APP_ROWS + PICKER_MIN_VISIBLE + 5;
/**
 * The least a picker can be used in: 3 rows plus the one hint line (4), plus the
 * 4 rows of frame, Esc line and footer, inside a frame one row shorter than the
 * terminal. Under 3 rows there is no row before or after the marked one to see.
 */
export const PICKER_MIN_ROWS = PICKER_MIN_VISIBLE + 1 + (PICKER_SHORT_APP_ROWS - 1) + 1;

/** True when the app should hide its banner, tabs and NOW strip for the picker. */
export function pickerHidesChrome(terminalRows: number | undefined): boolean {
	return !!terminalRows && terminalRows > 0 && terminalRows < PICKER_SHORT_BELOW_ROWS;
}

export interface PickerLayout {
	/** Under PICKER_MIN_ROWS: show one line and let Enter do nothing. */
	refuse: boolean;
	visible: number;
	showTitle: boolean;
	/** Compact: one combined line for the rows above and below. */
	oneScrollLine: boolean;
	/** Short window: no card border, no title, one line for the counts and the keys. */
	bare: boolean;
}

/** The one line a short picker keeps: what is cut off, then the keys. Counts are the real ones. */
export function pickerBareHint(above: number, below: number, searchable: boolean): string {
	const cut = [
		above > 0 ? `\u25B2 ${above} more above` : "",
		below > 0 ? `\u25BC ${below} more below` : "",
	]
		.filter(Boolean)
		.join("  ");
	const keys = searchable ? "\u2191\u2193 Enter Esc  type to filter" : "\u2191\u2193 Enter Esc";
	return cut ? `${cut}   ${keys}` : keys;
}

/**
 * How many option rows to draw in the rows the app leaves the picker. From 26
 * terminal rows up this is the old cap. From 21 to 25 the card keeps its border
 * and the title, and the scroll lines fold into one. Under 21 the app hides its
 * own chrome and the picker is bare: rows plus one hint line. Under
 * PICKER_MIN_ROWS it refuses rather than draw a picker whose rows are clipped.
 */
export function pickerLayout(
	terminalRows: number | undefined,
	total: number,
	searching: boolean,
	maxVisible: number,
): PickerLayout {
	if (!isCompactPicker(terminalRows)) {
		return {
			refuse: false,
			visible: fitVisible(maxVisible, terminalRows),
			showTitle: true,
			oneScrollLine: false,
			bare: false,
		};
	}
	const rows = terminalRows as number;
	const search = searching ? 1 : 0;
	if (pickerHidesChrome(rows)) {
		if (rows < PICKER_MIN_ROWS) {
			return { refuse: true, visible: 0, showTitle: false, oneScrollLine: true, bare: true };
		}
		const room = rows - PICKER_SHORT_APP_ROWS - 1 - search;
		return {
			refuse: false,
			visible: Math.max(1, Math.min(total, maxVisible, room)),
			showTitle: false,
			oneScrollLine: true,
			bare: true,
		};
	}
	// Border 2, hint 1, title 1, one scroll line when the list is cut.
	const avail = rows - PICKER_APP_ROWS - 3 - search - 1;
	const visible = total <= avail ? Math.min(total, maxVisible) : Math.min(avail - 1, maxVisible);
	return {
		refuse: false,
		visible: Math.max(visible, 1),
		showTitle: true,
		oneScrollLine: true,
		bare: false,
	};
}

export function fitVisible(maxVisible: number, terminalRows: number | undefined): number {
	if (!terminalRows || terminalRows <= 0) return maxVisible;
	return Math.max(PICKER_MIN_VISIBLE, Math.min(maxVisible, terminalRows - PICKER_CHROME_ROWS));
}

// ============================================
// Main Select Input Component
// ============================================

export function SelectInput<T = string>({
	options,
	onSelect,
	onCancel,
	title,
	initialIndex = 0,
	maxVisible: maxVisibleProp = 8,
	showDescription = true,
	searchable = true,
	highlightColor = "cyan",
	refuseNote,
}: SelectInputProps<T>) {
	const { stdout } = useStdout();
	const compact = isCompactPicker(stdout?.rows);
	const inkHighlight = highlightColor as NonNullable<TextProps["color"]>;
	// useState here intentionally freezes a value at mount; recomputing per render would break stable references downstream.
	// react-doctor-disable-next-line react-doctor/no-derived-useState
	const [selectedIndex, setSelectedIndex] = useState(initialIndex);
	const [search, setSearch] = useState("");
	const filteredOptions = useMemo(
		() =>
			searchable && search
				? options.filter(
						(opt) =>
							opt.label.toLowerCase().includes(search.toLowerCase()) ||
							opt.description?.toLowerCase().includes(search.toLowerCase()),
					)
				: options,
		[options, search, searchable],
	);

	const layout = pickerLayout(stdout?.rows, filteredOptions.length, !!search, maxVisibleProp);
	const maxVisible = Math.max(1, layout.visible);

	const [scrollOffset, setScrollOffset] = useState(() =>
		clampScrollOffset(initialIndex, options.length, maxVisible),
	);
	// The window is derived each render so the marked row is on screen in the same frame.
	const shownOffset = Math.max(
		0,
		Math.min(
			selectedIndex < scrollOffset
				? selectedIndex
				: selectedIndex >= scrollOffset + maxVisible
					? selectedIndex - maxVisible + 1
					: scrollOffset,
			Math.max(0, filteredOptions.length - maxVisible),
		),
	);

	// Ensure selection is within bounds
	useEffect(() => {
		if (selectedIndex >= filteredOptions.length) {
			setSelectedIndex(Math.max(0, filteredOptions.length - 1));
		}
	}, [filteredOptions.length, selectedIndex]);

	// Handle scroll when selection goes out of view
	// react-doctor-disable-next-line react-doctor/no-effect-chain
	useEffect(() => {
		if (selectedIndex < scrollOffset) {
			setScrollOffset(selectedIndex);
		} else if (selectedIndex >= scrollOffset + maxVisible) {
			setScrollOffset(selectedIndex - maxVisible + 1);
		}
	}, [selectedIndex, scrollOffset, maxVisible]);

	// Handle keyboard input
	useInput((input, key) => {
		if (key.escape) {
			onCancel?.();
			return;
		}

		if (key.return) {
			if (layout.refuse) return;
			const selected = filteredOptions[selectedIndex];
			if (selected && !selected.disabled) {
				onSelect(selected.value);
			}
			return;
		}

		if (key.downArrow) {
			setSelectedIndex((prev) => {
				let next = prev + 1;
				// Skip disabled options
				while (next < filteredOptions.length && filteredOptions[next]?.disabled) {
					next++;
				}
				return Math.min(next, filteredOptions.length - 1);
			});
			return;
		}

		if (key.upArrow) {
			setSelectedIndex((prev) => {
				let next = prev - 1;
				// Skip disabled options
				while (next >= 0 && filteredOptions[next]?.disabled) {
					next--;
				}
				return Math.max(next, 0);
			});
			return;
		}

		// Searchable - handle typing
		if (searchable && input && !key.ctrl && !key.meta) {
			setSearch((prev) => prev + input);
			setSelectedIndex(0);
			setScrollOffset(0);
		}

		// Backspace for search
		if (key.backspace || key.delete) {
			setSearch((prev) => prev.slice(0, -1));
		}
	});

	// Visible slice of options
	if (layout.refuse) {
		return (
			<Box>
				<MutedText wrap="truncate-end">
					{`Too short: needs ${PICKER_MIN_ROWS} rows, has ${stdout?.rows}. Make it taller.${refuseNote ? ` ${refuseNote}` : ""}`}
				</MutedText>
			</Box>
		);
	}

	const scrollOffsetShown = shownOffset;
	const visibleOptions = filteredOptions.slice(scrollOffsetShown, scrollOffsetShown + maxVisible);
	const hasMore = filteredOptions.length > maxVisible;
	const canScrollUp = scrollOffsetShown > 0;
	const canScrollDown = scrollOffsetShown + maxVisible < filteredOptions.length;
	const below = filteredOptions.length - scrollOffsetShown - maxVisible;

	const body = (
		<>
			{/* Title */}
			{title && layout.showTitle && (
				<Box marginBottom={compact ? 0 : 1}>
					<Heading color={inkHighlight}>{title}</Heading>
				</Box>
			)}

			{/* Search input (if searchable and has search) */}
			{searchable && search && (
				<Inline gap={0} marginBottom={compact ? 0 : 1}>
					<MutedText>Search: </MutedText>
					<AppText color="yellow">{search}</AppText>
					<MutedText> (Backspace to clear)</MutedText>
				</Inline>
			)}

			{/* Scroll up indicator */}
			{hasMore && layout.oneScrollLine && compact && !layout.bare && (
				<Box>
					<MutedText wrap="truncate-end">
						{canScrollUp ? ` ▲ ${scrollOffsetShown} more above` : ""}
						{canScrollUp && canScrollDown ? "  " : ""}
						{canScrollDown ? `▼ ${below} more below` : ""}
					</MutedText>
				</Box>
			)}
			{hasMore && !compact && canScrollUp && (
				<Box>
					<MutedText> ▲ {scrollOffsetShown} more above</MutedText>
				</Box>
			)}

			{/* Options */}
			{visibleOptions.map((option, index) => {
				const actualIndex = scrollOffsetShown + index;
				const isSelected = actualIndex === selectedIndex;
				const isDisabled = option.disabled;

				return (
					<Stack key={String(option.value)} gap={0}>
						<Inline gap={0}>
							{/* Selection indicator (avoid color="gray" — invisible on some themes) */}
							{isSelected ? (
								<AppText color={inkHighlight}>{"\u276F "}</AppText>
							) : (
								<AppText dimColor>{"  "}</AppText>
							)}

							{/* Icon if present (omit placeholder spaces — they still rendered a column) */}
							{option.icon ? <AppText dimColor={isDisabled}>{option.icon} </AppText> : null}

							{/* Label */}
							{isDisabled || option.dim ? (
								<MutedText wrap="truncate-middle">{option.label}</MutedText>
							) : (
								<AppText
									color={isSelected ? inkHighlight : undefined}
									bold={isSelected}
									wrap="truncate-middle"
								>
									{option.label}
								</AppText>
							)}

							{/* Colour preview: background-coloured cells after the label */}
							{option.swatches?.length ? (
								<AppText>
									{"  "}
									{option.swatches.map((hex, i) => (
										<AppText key={`${hex}-${i}`} backgroundColor={hex}>
											{"  "}
										</AppText>
									))}
								</AppText>
							) : null}

							{/* Disabled indicator */}
							{isDisabled && <MutedText> (unavailable)</MutedText>}
						</Inline>

						{/* Description (only for selected item) */}
						{showDescription && !compact && isSelected && option.description && (
							<Box paddingLeft={4}>
								<MutedText wrap="truncate-end">{option.description}</MutedText>
							</Box>
						)}
					</Stack>
				);
			})}

			{/* Scroll down indicator */}
			{hasMore && !compact && canScrollDown && (
				<Box>
					<MutedText>
						{"  "}▼ {below} more below
					</MutedText>
				</Box>
			)}

			{/* Empty state */}
			{filteredOptions.length === 0 && (
				<Box>
					<MutedText>No options match "{search}"</MutedText>
				</Box>
			)}

			{/* Help text */}
			<Box marginTop={compact ? 0 : 1}>
				<MutedText wrap="truncate-end">
					{layout.bare
						? pickerBareHint(scrollOffsetShown, Math.max(0, below), searchable)
						: pickerHint(stdout?.columns, searchable)}
				</MutedText>
			</Box>
		</>
	);
	return layout.bare ? (
		<Box flexDirection="column">{body}</Box>
	) : (
		<Card borderColor="blue">{body}</Card>
	);
}

// ============================================
// Quick Yes/No Confirm Dialog
// ============================================

export interface ConfirmDialogProps {
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
	defaultYes?: boolean;
	yesLabel?: string;
	noLabel?: string;
}

export function ConfirmDialog({
	message,
	onConfirm,
	onCancel,
	defaultYes = false,
	yesLabel = "Yes",
	noLabel = "No",
}: ConfirmDialogProps) {
	const [selected, setSelected] = useState(defaultYes ? 0 : 1);

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return) {
			if (selected === 0) {
				onConfirm();
			} else {
				onCancel();
			}
			return;
		}

		if (key.leftArrow || key.upArrow) {
			setSelected(0);
		}

		if (key.rightArrow || key.downArrow) {
			setSelected(1);
		}

		// Y for yes, N for no
		if (input?.toLowerCase() === "y") {
			onConfirm();
		} else if (input?.toLowerCase() === "n") {
			onCancel();
		}
	});

	return (
		<Card borderColor="yellow">
			<AppText color="yellow">{message}</AppText>
			<Inline gap={2} marginTop={1}>
				<AppText color={selected === 0 ? "green" : "gray"} bold={selected === 0}>
					{selected === 0 ? "❯ " : "  "}
					{yesLabel}
				</AppText>
				<AppText color={selected === 1 ? "red" : "gray"} bold={selected === 1}>
					{selected === 1 ? "❯ " : "  "}
					{noLabel}
				</AppText>
			</Inline>
			<Box marginTop={1}>
				<MutedText>[Y/N] or [←→] to select, [Enter] to confirm</MutedText>
			</Box>
		</Card>
	);
}

// ============================================
// Quick Action Menu (like command palette)
// ============================================

export interface QuickAction<T = string> {
	label: string;
	value: T;
	shortcut?: string;
	icon?: string;
}

export interface QuickMenuProps<T = string> {
	actions: QuickAction<T>[];
	onSelect: (value: T) => void;
	onCancel?: () => void;
	title?: string;
}

export function QuickMenu<T = string>({
	actions,
	onSelect,
	onCancel,
	title = "Quick Actions",
}: QuickMenuProps<T>) {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((input, key) => {
		if (key.escape) {
			onCancel?.();
			return;
		}

		if (key.return) {
			onSelect(actions[selectedIndex].value);
			return;
		}

		if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(prev + 1, actions.length - 1));
		}

		if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		}

		// Check for shortcut key
		const action = actions.find((a) => a.shortcut?.toLowerCase() === input?.toLowerCase());
		if (action) {
			onSelect(action.value);
		}
	});

	return (
		<Card borderColor="cyan">
			<Heading>{title}</Heading>
			<Stack marginTop={1}>
				{actions.map((action, index) => (
					<Inline gap={0} key={String(action.value)}>
						<Label color={index === selectedIndex ? "cyan" : undefined}>
							{index === selectedIndex ? "❯ " : "  "}
							{action.icon && `${action.icon} `}
							{action.label}
						</Label>
						{action.shortcut && <MutedText> [{action.shortcut}]</MutedText>}
					</Inline>
				))}
			</Stack>
		</Card>
	);
}

// ============================================
// Model Selector (Pre-built)
// ============================================

export interface ModelSelectorProps {
	models: string[];
	currentModel: string;
	onSelect: (model: string) => void;
	onCancel: () => void;
	provider?: string;
}

export function ModelSelector({
	models,
	currentModel,
	onSelect,
	onCancel,
	provider = "Ollama",
}: ModelSelectorProps) {
	const options: SelectOption<string>[] = models.map((model) => ({
		label: model,
		value: model,
		icon: model === currentModel ? "\u2713" : undefined,
		description: model === currentModel ? "Currently active" : undefined,
	}));

	const currentIndex = models.findIndex((m) => m === currentModel);

	return (
		<SelectInput
			key={`models-${models.join("\0")}`}
			title={`Select Model (${provider})`}
			options={options}
			onSelect={onSelect}
			onCancel={onCancel}
			initialIndex={Math.max(0, currentIndex)}
			highlightColor="green"
			refuseNote="Or use /model <name>."
		/>
	);
}

// ============================================
// Provider Selector (Pre-built)
// ============================================

export interface ProviderOption {
	name: string;
	displayName: string;
	hasApiKey: boolean;
	/** False for a provider that takes no key (local engines). Absent means it does. */
	needsKey?: boolean;
	enabled: boolean;
	/** Set by orderProviders (lib/provider-order.ts): can it run right now? */
	availability?: "runnable" | "not-reachable" | "unavailable";
}

export interface ProviderSelectorProps {
	providers: ProviderOption[];
	currentProvider: string;
	onSelect: (provider: string) => void;
	onCancel: () => void;
}

export function ProviderSelector({
	providers,
	currentProvider,
	onSelect,
	onCancel,
}: ProviderSelectorProps) {
	const options: SelectOption<string>[] = providers.map((p) => {
		const active = p.name === currentProvider;
		const availability = p.availability ?? "runnable";
		return {
			label: p.displayName,
			value: p.name,
			icon: active ? "\u2713" : p.hasApiKey ? "\u{1F511}" : undefined,
			description: providerRowNote({ ...p, availability }, active),
			disabled: !p.enabled && p.name !== "ollama" && availability === "unavailable",
			dim: availability !== "runnable",
		};
	});

	const currentIndex = providers.findIndex((p) => p.name === currentProvider);

	return (
		<SelectInput
			title="Select Provider"
			options={options}
			onSelect={onSelect}
			onCancel={onCancel}
			initialIndex={Math.max(0, currentIndex)}
			highlightColor="magenta"
		/>
	);
}
