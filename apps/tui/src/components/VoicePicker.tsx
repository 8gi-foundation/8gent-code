/**
 * VoicePicker - grouped list of the voices this machine can speak with.
 *
 * Two pieces, following CommandPalette:
 *   - VoicePicker: owns state and useInput, previews through the real engine.
 *   - VoicePickerView: stateless render, snapshot-able in tests.
 *
 * Keys: Up/Down move, Tab and Shift+Tab jump between groups, `/` filters by
 * name or language, `p` or Space previews the highlighted voice, Enter
 * chooses, Esc cancels, `?` shows help. List logic lives in
 * lib/voice-picker-model.ts. Theme tokens and primitives only.
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { VoiceCatalog, VoiceEntry } from "../../../../packages/voice/voice-catalog.js";
import { previewVoice } from "../../../../packages/voice/voice-catalog.js";
import {
	type PickerRow,
	type PickerState,
	type VoiceRef,
	buildRows,
	computeRowWindow,
	countVoices,
	initialState,
	reducePicker,
	rowIndexOf,
	sameVoice,
	visibleVoices,
} from "../lib/voice-picker-model.js";
import { t } from "../theme.js";
import { AppText, Divider, Heading, MutedText } from "./primitives/index.js";

export interface VoicePickerProps {
	/** null while the catalog is loading. */
	catalog: VoiceCatalog | null;
	loadError?: string | null;
	title: string;
	current: VoiceRef | null;
	onChoose: (entry: VoiceEntry) => void;
	onCancel: () => void;
	/** Speak the preview sentence for one voice. Defaults to the real engine. */
	onPreview?: (entry: VoiceEntry) => Promise<unknown>;
	visibleRows?: number;
	isActive?: boolean;
}

export interface VoicePickerViewProps {
	catalog: VoiceCatalog;
	title: string;
	state: PickerState;
	current: VoiceRef | null;
	previewing: VoiceRef | null;
	previewNote: string | null;
	visibleRows: number;
}

const DEFAULT_ROWS = 14;

export function VoicePicker({
	catalog,
	loadError,
	title,
	current,
	onChoose,
	onCancel,
	onPreview,
	visibleRows = DEFAULT_ROWS,
	isActive = true,
}: VoicePickerProps): React.ReactElement {
	const [state, setState] = useState<PickerState | null>(null);
	const [previewing, setPreviewing] = useState<VoiceRef | null>(null);
	const [previewNote, setPreviewNote] = useState<string | null>(null);

	// Reset the highlight when a new catalog or a new target arrives.
	// react-doctor-disable-next-line react-doctor/no-effect-event-handler
	useEffect(() => {
		if (catalog) setState(initialState(catalog, current));
	}, [catalog, current]);

	const rows = useMemo(
		() => (catalog && state ? buildRows(catalog, state.filter) : []),
		[catalog, state],
	);

	const preview = useCallback(
		(entry: VoiceEntry) => {
			const speak = onPreview ?? ((e: VoiceEntry) => previewVoice(e.engine, e.id));
			setPreviewing({ engine: entry.engine, id: entry.id });
			setPreviewNote(null);
			speak(entry)
				.then(() => setPreviewNote(`${entry.name} on ${entry.engine}`))
				.catch((err: unknown) => {
					setPreviewNote(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
				});
		},
		[onPreview],
	);

	useInput(
		(input, key) => {
			if (!catalog || !state) {
				if (key.escape) onCancel();
				return;
			}
			const dispatch = (action: Parameters<typeof reducePicker>[1]) =>
				setState((s) => (s ? reducePicker(s, action, catalog) : s));
			if (state.showHelp) {
				if (input === "?" || key.escape || input === "q") dispatch({ type: "toggleHelp" });
				return;
			}
			if (key.upArrow) return dispatch({ type: "up" });
			if (key.downArrow) return dispatch({ type: "down" });
			if (key.tab) return dispatch({ type: key.shift ? "prevGroup" : "nextGroup" });
			const highlighted = visibleVoices(rows)[state.highlight];
			if (key.return) {
				if (state.filtering) return dispatch({ type: "endFilter" });
				if (highlighted) onChoose(highlighted);
				return;
			}
			if (state.filtering) {
				if (key.escape) return dispatch({ type: "clearFilter" });
				if (key.backspace || key.delete) return dispatch({ type: "filterBackspace" });
				if (input && !key.ctrl && !key.meta) dispatch({ type: "filterChar", char: input });
				return;
			}
			if (key.escape) return onCancel();
			if (input === "/") return dispatch({ type: "startFilter" });
			if (input === "?") return dispatch({ type: "toggleHelp" });
			if ((input === "p" || input === " ") && highlighted) preview(highlighted);
		},
		{ isActive },
	);

	if (loadError) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Heading>{title}</Heading>
				<Text color="red">{loadError}</Text>
				<MutedText>Esc to close</MutedText>
			</Box>
		);
	}
	if (!catalog || !state) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Heading>{title}</Heading>
				<MutedText>Finding the voices this machine can speak with...</MutedText>
			</Box>
		);
	}
	return (
		<VoicePickerView
			catalog={catalog}
			title={title}
			state={state}
			current={current}
			previewing={previewing}
			previewNote={previewNote}
			visibleRows={visibleRows}
		/>
	);
}

function label(ref: VoiceRef | null): string {
	return ref ? `${ref.id} (${ref.engine})` : "none";
}

export function VoicePickerView({
	catalog,
	title,
	state,
	current,
	previewing,
	previewNote,
	visibleRows,
}: VoicePickerViewProps): React.ReactElement {
	if (state.showHelp) return <HelpView title={title} />;
	const rows = buildRows(catalog, state.filter);
	const total = countVoices(catalog);
	const shown = visibleVoices(rows).length;
	const target = rowIndexOf(rows, state.highlight);
	const { start, end } = computeRowWindow(rows, target, visibleRows);
	const window = rows.slice(start, end);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={t.orange} paddingX={1}>
			<Box>
				<Heading>{title}</Heading>
				<MutedText>
					{"  "}
					{total} voice{total === 1 ? "" : "s"} on this machine
					{state.filter ? `, ${shown} match` : ""}
				</MutedText>
			</Box>
			<Box>
				<MutedText>current: </MutedText>
				<AppText>{label(current)}</AppText>
				<MutedText>{"  "}recommended: </MutedText>
				<AppText>{label(catalog.recommended)}</AppText>
			</Box>
			{catalog.unavailable.map((u) => (
				<MutedText key={u.engine}>
					{u.engine}: {u.reason}
				</MutedText>
			))}
			{state.filtering || state.filter ? (
				<Box>
					<Text color={t.orange}>/ </Text>
					<AppText>{state.filter}</AppText>
					<Text color={t.orange}>{state.filtering ? "_" : ""}</Text>
				</Box>
			) : null}
			<Divider />
			{start > 0 ? (
				<MutedText>
					{"  "}up {start} more
				</MutedText>
			) : null}
			{window.length === 0 ? <MutedText>no voice matches "{state.filter}"</MutedText> : null}
			{window.map((row) => (
				<RowView
					key={row.kind === "heading" ? `h:${row.group}` : `v:${row.entry.engine}:${row.entry.id}`}
					row={row}
					active={row.kind === "voice" && row.index === state.highlight}
					isCurrent={row.kind === "voice" && sameVoice(row.entry, current)}
					isRecommended={row.kind === "voice" && sameVoice(row.entry, catalog.recommended)}
					isPreviewing={row.kind === "voice" && sameVoice(row.entry, previewing)}
				/>
			))}
			{end < rows.length ? (
				<MutedText>
					{"  "}down {rows.length - end} more
				</MutedText>
			) : null}
			<Divider />
			{previewNote ? <MutedText>preview: {previewNote}</MutedText> : null}
			<MutedText>
				Up/Down move · Tab groups · / filter · p preview · Enter choose · Esc cancel · ? help
			</MutedText>
		</Box>
	);
}

function RowView({
	row,
	active,
	isCurrent,
	isRecommended,
	isPreviewing,
}: {
	row: PickerRow;
	active: boolean;
	isCurrent: boolean;
	isRecommended: boolean;
	isPreviewing: boolean;
}): React.ReactElement {
	if (row.kind === "heading") {
		return (
			<Box marginTop={1}>
				<Text color="cyan" bold>
					{row.label}
				</Text>
				<MutedText> ({row.count})</MutedText>
			</Box>
		);
	}
	const marks = [
		isCurrent ? "current" : null,
		isRecommended ? "recommended" : null,
		isPreviewing ? "playing" : null,
	].filter((m): m is string => m !== null);
	return (
		<Box>
			<Text color={active ? t.orange : t.textTertiary}>{active ? "> " : "  "}</Text>
			<Text color={active ? t.orange : undefined} bold={active}>
				{row.entry.name}
			</Text>
			{row.entry.hint ? (
				<MutedText>
					{"  "}
					{row.entry.hint}
				</MutedText>
			) : null}
			{marks.length > 0 ? (
				<Text color="green">
					{"  "}
					{marks.join(", ")}
				</Text>
			) : null}
		</Box>
	);
}

function HelpView({ title }: { title: string }): React.ReactElement {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={t.orange} paddingX={1}>
			<Heading>{title} - Help</Heading>
			<Divider />
			<AppText>Up/Down Move between voices</AppText>
			<AppText>Tab, Shift+Tab Jump to the next or previous group</AppText>
			<AppText>/ Filter by name or language; Enter keeps it, Esc clears it</AppText>
			<AppText>p or Space Preview the highlighted voice</AppText>
			<AppText>Enter Choose the highlighted voice</AppText>
			<AppText>Esc Cancel</AppText>
			<AppText>? Show or hide this help</AppText>
			<Divider />
			<MutedText>Press ? or Esc to dismiss</MutedText>
		</Box>
	);
}
