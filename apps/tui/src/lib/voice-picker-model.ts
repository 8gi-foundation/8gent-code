/**
 * Voice picker list logic, kept pure so it can be tested without Ink.
 *
 * The picker shows the voice catalog as grouped rows (a heading per group,
 * then its voices). The highlight lives in "voice space": an index into the
 * flat list of visible voices, so Up/Down never land on a heading. Tab and
 * Shift+Tab jump to the first voice of the next or previous group. `/`
 * opens a filter over name, hint and language; groups with no match vanish.
 */

import type {
	VoiceCatalog,
	VoiceEntry,
	VoiceGroupId,
} from "../../../../packages/voice/voice-catalog.js";

export type VoiceRef = { engine: string; id: string };

export type PickerRow =
	| { kind: "heading"; group: VoiceGroupId; label: string; count: number }
	| { kind: "voice"; group: VoiceGroupId; entry: VoiceEntry; index: number };

export interface PickerState {
	/** Index into the visible voices (not rows). */
	highlight: number;
	filter: string;
	/** True while `/` has focus and typed characters go to the filter. */
	filtering: boolean;
	showHelp: boolean;
}

export type PickerAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "nextGroup" }
	| { type: "prevGroup" }
	| { type: "startFilter" }
	| { type: "filterChar"; char: string }
	| { type: "filterBackspace" }
	| { type: "endFilter" }
	| { type: "clearFilter" }
	| { type: "toggleHelp" };

export function sameVoice(a: VoiceRef | null | undefined, b: VoiceRef | null | undefined): boolean {
	return !!a && !!b && a.engine === b.engine && a.id === b.id;
}

/** Case-insensitive match over name, id, hint and language code. */
export function matchesFilter(entry: VoiceEntry, filter: string): boolean {
	const q = filter.trim().toLowerCase();
	if (!q) return true;
	const hay = [entry.name, entry.id, entry.hint, entry.language ?? ""]
		.join(" ")
		.toLowerCase();
	return hay.includes(q);
}

/** Rows to render for the catalog under a filter. Empty groups are dropped. */
export function buildRows(catalog: VoiceCatalog, filter: string): PickerRow[] {
	const rows: PickerRow[] = [];
	let index = 0;
	for (const group of catalog.groups) {
		const voices = group.voices.filter((v) => matchesFilter(v, filter));
		if (voices.length === 0) continue;
		rows.push({ kind: "heading", group: group.id, label: group.label, count: voices.length });
		for (const entry of voices) {
			rows.push({ kind: "voice", group: group.id, entry, index });
			index++;
		}
	}
	return rows;
}

/** The visible voices in row order. */
export function visibleVoices(rows: PickerRow[]): VoiceEntry[] {
	const out: VoiceEntry[] = [];
	for (const row of rows) if (row.kind === "voice") out.push(row.entry);
	return out;
}

/** Row index of the highlighted voice, or -1 when nothing is visible. */
export function rowIndexOf(rows: PickerRow[], highlight: number): number {
	return rows.findIndex((r) => r.kind === "voice" && r.index === highlight);
}

/** Highlight the current voice, else the recommended one, else the first. */
export function initialHighlight(
	voices: VoiceEntry[],
	current: VoiceRef | null,
	recommended: VoiceRef | null,
): number {
	const cur = voices.findIndex((v) => sameVoice(v, current));
	if (cur >= 0) return cur;
	const rec = voices.findIndex((v) => sameVoice(v, recommended));
	return rec >= 0 ? rec : 0;
}

export function initialState(
	catalog: VoiceCatalog,
	current: VoiceRef | null,
	recommended: VoiceRef | null = catalog.recommended,
): PickerState {
	const voices = visibleVoices(buildRows(catalog, ""));
	return {
		highlight: initialHighlight(voices, current, recommended),
		filter: "",
		filtering: false,
		showHelp: false,
	};
}

function firstIndexOfGroup(rows: PickerRow[], group: VoiceGroupId): number {
	const row = rows.find((r) => r.kind === "voice" && r.group === group);
	return row && row.kind === "voice" ? row.index : 0;
}

function groupOrder(rows: PickerRow[]): VoiceGroupId[] {
	const seen: VoiceGroupId[] = [];
	for (const row of rows) if (row.kind === "heading") seen.push(row.group);
	return seen;
}

function jumpGroup(rows: PickerRow[], highlight: number, step: 1 | -1): number {
	const groups = groupOrder(rows);
	if (groups.length === 0) return 0;
	const currentRow = rows.find((r) => r.kind === "voice" && r.index === highlight);
	const at = currentRow ? groups.indexOf(currentRow.group) : 0;
	const next = (at + step + groups.length) % groups.length;
	return firstIndexOfGroup(rows, groups[next]);
}

/**
 * Re-point the highlight after the filter changed: keep the same voice when
 * it is still visible, otherwise fall back to the first visible voice.
 */
function rehighlight(catalog: VoiceCatalog, state: PickerState, nextFilter: string): PickerState {
	const before = visibleVoices(buildRows(catalog, state.filter))[state.highlight] ?? null;
	const after = visibleVoices(buildRows(catalog, nextFilter));
	const kept = after.findIndex((v) => sameVoice(v, before));
	return { ...state, filter: nextFilter, highlight: kept >= 0 ? kept : 0 };
}

/** Keyboard model. Pure: same state and action always give the same state. */
export function reducePicker(
	state: PickerState,
	action: PickerAction,
	catalog: VoiceCatalog,
): PickerState {
	const rows = buildRows(catalog, state.filter);
	const count = visibleVoices(rows).length;
	const clamp = (i: number): number => Math.max(0, Math.min(Math.max(0, count - 1), i));
	switch (action.type) {
		case "up":
			return { ...state, highlight: clamp(state.highlight - 1) };
		case "down":
			return { ...state, highlight: clamp(state.highlight + 1) };
		case "nextGroup":
			return { ...state, highlight: jumpGroup(rows, state.highlight, 1) };
		case "prevGroup":
			return { ...state, highlight: jumpGroup(rows, state.highlight, -1) };
		case "startFilter":
			return { ...state, filtering: true, showHelp: false };
		case "filterChar":
			return rehighlight(catalog, state, state.filter + action.char);
		case "filterBackspace":
			if (state.filter.length === 0) return { ...state, filtering: false };
			return rehighlight(catalog, state, state.filter.slice(0, -1));
		case "endFilter":
			return { ...state, filtering: false };
		case "clearFilter":
			return { ...rehighlight(catalog, state, ""), filtering: false };
		case "toggleHelp":
			return { ...state, showHelp: !state.showHelp };
		default:
			return state;
	}
}

/**
 * Sliding window over the rows that always contains `targetRow`. When the
 * row just above the target is its group heading, the heading is kept in
 * view too, so a voice never appears without its group label.
 */
export function computeRowWindow(
	rows: PickerRow[],
	targetRow: number,
	visible: number,
): { start: number; end: number } {
	const total = rows.length;
	if (total <= visible) return { start: 0, end: total };
	const target = Math.max(0, Math.min(total - 1, targetRow));
	const anchor = target > 0 && rows[target - 1]?.kind === "heading" ? target - 1 : target;
	const half = Math.floor(visible / 2);
	const start = Math.max(0, Math.min(anchor - half, total - visible));
	return { start, end: Math.min(total, start + visible) };
}

/** Total voices in the catalog, all groups. */
export function countVoices(catalog: VoiceCatalog): number {
	return catalog.groups.reduce((n, g) => n + g.voices.length, 0);
}
