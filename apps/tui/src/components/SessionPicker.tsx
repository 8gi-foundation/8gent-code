/**
 * SessionPicker - the /resume overlay over the JSONL tree store.
 *
 * Data comes from listSessions() in packages/eight/session-store.ts; the
 * caller passes the list in and acts on the result, so this file never
 * touches the disk. The wiring (which command opens it, what Enter does)
 * belongs to app.tsx.
 *
 * Keys:
 *   type        search name, id, folder and model
 *   Up/Down     move
 *   Enter       open the session
 *   Tab         this folder <-> all folders
 *   Ctrl+N      named sessions only
 *   Ctrl+S      sort: recent <-> name
 *   Ctrl+R      rename (type the name, Enter saves, Esc cancels)
 *   Ctrl+D      delete (asks y/n; the store moves the file to trash/)
 *   Esc         close
 *
 * Logic lives in pure functions (pickerReducer, keyToAction, visibleSessions)
 * so it is tested without an Ink render loop; SessionPickerView is stateless.
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useReducer } from "react";
import { cleanName, normalizeCwd } from "../../../../packages/eight/session-store.js";
import type { SessionListItem } from "../../../../packages/eight/session-store.js";
import { t } from "../theme.js";
import { KeyCapRow } from "./KeyCap.js";

export type PickerScope = "cwd" | "all";
export type PickerSort = "recent" | "name";
export type PickerMode = "browse" | "rename" | "confirm-delete";

export interface PickerState {
	query: string;
	active: number;
	scope: PickerScope;
	sort: PickerSort;
	namedOnly: boolean;
	mode: PickerMode;
	/** Text being typed in rename mode. */
	draft: string;
}

export type PickerAction =
	| { type: "type"; text: string }
	| { type: "backspace" }
	| { type: "move"; delta: number; total: number }
	| { type: "toggle-scope" }
	| { type: "toggle-sort" }
	| { type: "toggle-named" }
	| { type: "start-rename"; current: string }
	| { type: "start-delete" }
	| { type: "cancel" };

/** What the caller must do after a key, if anything. */
export type PickerEffect =
	| { type: "open"; id: string }
	| { type: "rename"; id: string; name: string }
	| { type: "delete"; id: string }
	| { type: "close" };

export const initialPickerState = (scope: PickerScope = "cwd"): PickerState => ({
	query: "",
	active: 0,
	scope,
	sort: "recent",
	namedOnly: false,
	mode: "browse",
	draft: "",
});

export function pickerReducer(s: PickerState, a: PickerAction): PickerState {
	switch (a.type) {
		case "type":
			return s.mode === "rename"
				? { ...s, draft: s.draft + a.text }
				: { ...s, query: s.query + a.text, active: 0 };
		case "backspace":
			return s.mode === "rename"
				? { ...s, draft: s.draft.slice(0, -1) }
				: { ...s, query: s.query.slice(0, -1), active: 0 };
		case "move":
			return { ...s, active: Math.max(0, Math.min(Math.max(0, a.total - 1), s.active + a.delta)) };
		case "toggle-scope":
			return { ...s, scope: s.scope === "cwd" ? "all" : "cwd", active: 0 };
		case "toggle-sort":
			return { ...s, sort: s.sort === "recent" ? "name" : "recent", active: 0 };
		case "toggle-named":
			return { ...s, namedOnly: !s.namedOnly, active: 0 };
		case "start-rename":
			return { ...s, mode: "rename", draft: a.current };
		case "start-delete":
			return { ...s, mode: "confirm-delete" };
		case "cancel":
			return { ...s, mode: "browse", draft: "" };
	}
}

/** Filter, scope and sort. Pure: the same inputs give the same rows. */
export function visibleSessions(
	sessions: SessionListItem[],
	s: Pick<PickerState, "query" | "scope" | "sort" | "namedOnly">,
	cwd: string,
): SessionListItem[] {
	const here = normalizeCwd(cwd);
	const q = s.query.trim().toLowerCase();
	const rows = sessions.filter((x) => {
		if (s.scope === "cwd" && normalizeCwd(x.cwd) !== here) return false;
		if (s.namedOnly && !x.name) return false;
		if (!q) return true;
		return [x.name ?? "", x.id, x.cwd, x.model ?? ""].join(" ").toLowerCase().includes(q);
	});
	const byRecent = (a: SessionListItem, b: SessionListItem) =>
		Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) || a.id.localeCompare(b.id);
	return [...rows].sort(
		s.sort === "name"
			? (a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿") || byRecent(a, b)
			: byRecent,
	);
}

export interface KeyLike {
	return?: boolean;
	escape?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
	backspace?: boolean;
	delete?: boolean;
	tab?: boolean;
	ctrl?: boolean;
	meta?: boolean;
}

/**
 * Map one key to a state change and/or an effect for the caller.
 * `rows` is the list on screen now; the selected row is rows[state.active].
 */
export function keyToAction(
	input: string,
	key: KeyLike,
	state: PickerState,
	rows: SessionListItem[],
): { action?: PickerAction; effect?: PickerEffect } {
	const selected = rows[state.active];
	if (state.mode === "confirm-delete") {
		if (input === "y" && selected) {
			return { action: { type: "cancel" }, effect: { type: "delete", id: selected.id } };
		}
		return { action: { type: "cancel" } };
	}
	if (state.mode === "rename") {
		if (key.escape) return { action: { type: "cancel" } };
		if (key.return) {
			const name = state.draft.trim();
			return {
				action: { type: "cancel" },
				effect: selected && name ? { type: "rename", id: selected.id, name } : undefined,
			};
		}
		if (key.backspace || key.delete) return { action: { type: "backspace" } };
		if (input && !key.ctrl && !key.meta) return { action: { type: "type", text: input } };
		return {};
	}
	if (key.escape) return { effect: { type: "close" } };
	if (key.return) return selected ? { effect: { type: "open", id: selected.id } } : {};
	if (key.upArrow) return { action: { type: "move", delta: -1, total: rows.length } };
	if (key.downArrow) return { action: { type: "move", delta: 1, total: rows.length } };
	if (key.tab) return { action: { type: "toggle-scope" } };
	if (key.ctrl && input === "n") return { action: { type: "toggle-named" } };
	if (key.ctrl && input === "s") return { action: { type: "toggle-sort" } };
	if (key.ctrl && input === "r") {
		return selected ? { action: { type: "start-rename", current: selected.name ?? "" } } : {};
	}
	if (key.ctrl && input === "d") return selected ? { action: { type: "start-delete" } } : {};
	if (key.backspace || key.delete) return { action: { type: "backspace" } };
	if (input && !key.ctrl && !key.meta && input.length === 1) {
		return { action: { type: "type", text: input } };
	}
	return {};
}

export interface SessionPickerProps {
	isOpen: boolean;
	sessions: SessionListItem[];
	cwd: string;
	onOpen: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
	onClose: () => void;
	/** Start scoped to this folder (default) or showing every folder. */
	initialScope?: PickerScope;
	/** Clock for the "5m ago" column; tests pin it. */
	now?: number;
}

export function SessionPicker(props: SessionPickerProps): React.ReactElement | null {
	const [state, dispatch] = useReducer(pickerReducer, props.initialScope, initialPickerState);
	const rows = useMemo(
		() => visibleSessions(props.sessions, state, props.cwd),
		[props.sessions, state, props.cwd],
	);
	const active = Math.min(state.active, Math.max(0, rows.length - 1));

	useInput(
		(input, key) => {
			const { action, effect } = keyToAction(input, key, { ...state, active }, rows);
			if (action) dispatch(action);
			if (!effect) return;
			if (effect.type === "close") props.onClose();
			else if (effect.type === "open") {
				// Close first so the next view's input handler does not race this one (#2388).
				props.onClose();
				props.onOpen(effect.id);
			} else if (effect.type === "rename") props.onRename(effect.id, effect.name);
			else props.onDelete(effect.id);
		},
		{ isActive: props.isOpen },
	);

	if (!props.isOpen) return null;
	return <SessionPickerView state={{ ...state, active }} rows={rows} now={props.now} />;
}

const WIDTH = 72;
const VISIBLE_ROWS = 10;

export function ago(iso: string, now: number = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
	if (Number.isNaN(mins)) return "";
	if (mins < 60) return `${mins}m`;
	if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
	return `${Math.floor(mins / (60 * 24))}d`;
}

function fit(s: string, width: number): string {
	return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
}

export function SessionPickerView({
	state,
	rows,
	now,
}: {
	state: PickerState;
	rows: SessionListItem[];
	now?: number;
}): React.ReactElement {
	const half = Math.floor(VISIBLE_ROWS / 2);
	const start = Math.max(0, Math.min(state.active - half, rows.length - VISIBLE_ROWS));
	const shown = rows.slice(start, start + VISIBLE_ROWS);
	const selected = rows[state.active];
	const title = [
		state.scope === "cwd" ? "this folder" : "all folders",
		state.sort === "recent" ? "recent" : "by name",
		state.namedOnly ? "named only" : "",
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.orange}
			paddingX={1}
			width={WIDTH}
			flexShrink={0}
		>
			<Box>
				<Text color={t.orange} bold>
					SESSIONS
				</Text>
				<Text color={t.textTertiary}> {title}</Text>
			</Box>
			<Box>
				<Text color={t.orange}>» </Text>
				{state.query ? (
					<Text color={t.cream}>{state.query}</Text>
				) : (
					<Text color={t.textTertiary}>type to search</Text>
				)}
			</Box>
			{start > 0 ? <Text color={t.textTertiary}> ↑ {start} more</Text> : null}
			{shown.length === 0 ? (
				<Text color={t.textTertiary}>
					{state.scope === "cwd" ? "no sessions in this folder (Tab shows all)" : "no sessions"}
				</Text>
			) : (
				shown.map((s, i) => {
					const isActive = start + i === state.active;
					// Names and folders come from files: no escape sequence reaches the terminal.
					const label = cleanName(s.name ?? `untitled ${s.id}`);
					return (
						<Box key={s.id}>
							<Text color={isActive ? t.orange : t.textTertiary}>{isActive ? "◆ " : "○ "}</Text>
							<Text color={isActive ? t.orange : t.textPrimary} bold={isActive}>
								{fit(label, 28)}
							</Text>
							<Text color={t.textSecondary}> {fit(`${s.messageCount} msgs`, 9)}</Text>
							<Text color={t.textTertiary}> {fit(ago(s.lastActiveAt, now), 4)}</Text>
							{state.scope === "all" ? (
								<Text color={t.textTertiary} wrap="truncate-start">
									{" "}
									{cleanName(s.cwd)}
								</Text>
							) : null}
						</Box>
					);
				})
			)}
			{start + VISIBLE_ROWS < rows.length ? (
				<Text color={t.textTertiary}> ↓ {rows.length - start - VISIBLE_ROWS} more</Text>
			) : null}
			{state.mode === "rename" ? (
				<Box>
					<Text color={t.orange}>rename: </Text>
					<Text color={t.cream}>{state.draft}</Text>
					<Text color={t.textTertiary}> (Enter saves, Esc cancels)</Text>
				</Box>
			) : null}
			{state.mode === "confirm-delete" && selected ? (
				<Text color={t.orange}>
					Delete "{cleanName(selected.name ?? selected.id)}"? y / n (moved to trash)
				</Text>
			) : null}
			<Box>
				<KeyCapRow
					caps={[
						{ cap: "Enter", verb: "open" },
						{ cap: "Tab", verb: "folder/all" },
						{ cap: "^R", verb: "rename" },
						{ cap: "^D", verb: "delete" },
						{ cap: "^N", verb: "named" },
						{ cap: "^S", verb: "sort" },
					]}
					idPrefix="session-picker"
					z={20}
				/>
			</Box>
		</Box>
	);
}
