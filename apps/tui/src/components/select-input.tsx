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
}: SelectInputProps<T>) {
	const { stdout } = useStdout();
	const maxVisible = fitVisible(maxVisibleProp, stdout?.rows);
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

	const [scrollOffset, setScrollOffset] = useState(() =>
		clampScrollOffset(initialIndex, options.length, maxVisible),
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
	const visibleOptions = filteredOptions.slice(scrollOffset, scrollOffset + maxVisible);
	const hasMore = filteredOptions.length > maxVisible;
	const canScrollUp = scrollOffset > 0;
	const canScrollDown = scrollOffset + maxVisible < filteredOptions.length;

	return (
		<Card borderColor="blue">
			{/* Title */}
			{title && (
				<Box marginBottom={compact ? 0 : 1}>
					<Heading color={inkHighlight}>{title}</Heading>
				</Box>
			)}

			{/* Search input (if searchable and has search) */}
			{searchable && search && (
				<Inline gap={0} marginBottom={1}>
					<MutedText>Search: </MutedText>
					<AppText color="yellow">{search}</AppText>
					<MutedText> (Backspace to clear)</MutedText>
				</Inline>
			)}

			{/* Scroll up indicator */}
			{hasMore && canScrollUp && (
				<Box>
					<MutedText> ▲ {scrollOffset} more above</MutedText>
				</Box>
			)}

			{/* Options */}
			{visibleOptions.map((option, index) => {
				const actualIndex = scrollOffset + index;
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
			{hasMore && canScrollDown && (
				<Box>
					<MutedText>
						{"  "}▼ {filteredOptions.length - scrollOffset - maxVisible} more below
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
				<MutedText wrap="truncate-end">{pickerHint(stdout?.columns, searchable)}</MutedText>
			</Box>
		</Card>
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
