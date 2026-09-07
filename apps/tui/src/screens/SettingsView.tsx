/**
 * 8gent Code - Settings View
 *
 * In-TUI settings editor backed by @8gent/settings.
 * Categories on the left, fields on the right, every row laid out as
 * "marker  label(padded to a shared column)  value" so values line up.
 *
 * Widgets:
 *   - toggle  (boolean)        Space or Enter flips it
 *   - select  (enum string[])  Left/Right cycle, Space or Enter cycles forward
 *   - number  (number)         Left/Right adjust by the field's step; e or Enter edits
 *   - text    (string)         e or Enter edits
 *
 * Edit mode opens with the whole value selected, so typing replaces it.
 * Left/Right/Home/End drop into in-place editing. Enter validates; an invalid
 * value keeps the user in edit mode with their text and a one-line message
 * naming the rule. Esc cancels.
 *
 * Persistence: every committed change is written to the settings file after a
 * 500 ms debounce, and the header shows "saving" then "saved" so the user can
 * see that a write happened. Nothing is written until something changes.
 *
 * The footer tells the truth per row type: it only mentions Left/Right on the
 * rows where Left/Right do something.
 */

import * as os from "node:os";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import {
	type Settings,
	type TextRule,
	clampNumber,
	getSettingsFilePath,
	loadSettings,
	saveSettings,
	validateNumber,
	validateText,
} from "../../../../packages/settings/index.js";
import {
	AppText,
	ErrorText,
	Heading,
	MutedText,
	SuccessText,
} from "../components/primitives/AppText.js";
import { Divider } from "../components/primitives/Divider.js";
import { Stack } from "../components/primitives/Stack.js";
import { t } from "../theme.js";

// ----------------------------------------------------------------------------
// Field descriptors
// ----------------------------------------------------------------------------

export type FieldKind = "toggle" | "text" | "number" | "select";

interface BaseField {
	id: string;
	label: string;
	description: string;
	kind: FieldKind;
	get: (s: Settings) => unknown;
	set: (s: Settings, value: unknown) => Settings;
}

export interface ToggleField extends BaseField {
	kind: "toggle";
}

export interface TextField extends BaseField {
	kind: "text";
	rule: TextRule;
}

export interface NumberField extends BaseField {
	kind: "number";
	min: number;
	max: number;
	step: number;
}

export interface SelectField extends BaseField {
	kind: "select";
	options: readonly string[];
}

export type Field = ToggleField | TextField | NumberField | SelectField;

export interface Category {
	id: string;
	label: string;
	fields: Field[];
}

const VOICE_RULE: TextRule = { kind: "voice" };
const PROVIDER_RULE: TextRule = { kind: "identifier", what: "provider name" };
const MODEL_RULE: TextRule = { kind: "identifier", what: "model id" };
const URL_RULE: TextRule = { kind: "url" };
const THEME_RULE: TextRule = { kind: "identifier", what: "theme name" };

export const SETTINGS_CATEGORIES: readonly Category[] = [
	{
		id: "voice",
		label: "Voice",
		fields: [
			{
				id: "voice.silenceThresholdMs",
				label: "Silence threshold (ms)",
				description: "How long of a pause ends a voice utterance. Range 500-5000.",
				kind: "number",
				min: 500,
				max: 5000,
				step: 100,
				get: (s) => s.voice.silenceThresholdMs,
				set: (s, v) => ({
					...s,
					voice: { ...s.voice, silenceThresholdMs: clampNumber(Number(v), 500, 5000) },
				}),
			},
			{
				id: "voice.bargeIn",
				label: "Barge-in",
				description: "Allow speaking to interrupt TTS playback.",
				kind: "toggle",
				get: (s) => s.voice.bargeIn,
				set: (s, v) => ({ ...s, voice: { ...s.voice, bargeIn: Boolean(v) } }),
			},
			{
				id: "voice.ttsVoice",
				label: "TTS voice (fallback)",
				description:
					"macOS voice name used when a tab has no per-agent voice (e.g. Ava, Samantha, Daniel).",
				kind: "text",
				rule: VOICE_RULE,
				get: (s) => s.voice.ttsVoice,
				set: (s, v) => ({ ...s, voice: { ...s.voice, ttsVoice: String(v) } }),
			},
			{
				id: "voice.outputEnabled",
				label: "Speak agent replies",
				description: "When on, agent responses are spoken via macOS TTS by default.",
				kind: "toggle",
				get: (s) => s.voice.outputEnabled,
				set: (s, v) => ({
					...s,
					voice: { ...s.voice, outputEnabled: Boolean(v) },
				}),
			},
			{
				id: "voice.perAgent.orchestrator",
				label: "Orchestrator voice",
				description: "macOS voice for the Orchestrator tab.",
				kind: "text",
				rule: VOICE_RULE,
				get: (s) => s.voice.perAgent.orchestrator,
				set: (s, v) => ({
					...s,
					voice: {
						...s.voice,
						perAgent: { ...s.voice.perAgent, orchestrator: String(v) },
					},
				}),
			},
			{
				id: "voice.perAgent.engineer",
				label: "Engineer voice",
				description: "macOS voice for the Engineer tab.",
				kind: "text",
				rule: VOICE_RULE,
				get: (s) => s.voice.perAgent.engineer,
				set: (s, v) => ({
					...s,
					voice: {
						...s.voice,
						perAgent: { ...s.voice.perAgent, engineer: String(v) },
					},
				}),
			},
			{
				id: "voice.perAgent.qa",
				label: "QA voice",
				description: "macOS voice for the QA tab.",
				kind: "text",
				rule: VOICE_RULE,
				get: (s) => s.voice.perAgent.qa,
				set: (s, v) => ({
					...s,
					voice: {
						...s.voice,
						perAgent: { ...s.voice.perAgent, qa: String(v) },
					},
				}),
			},
		],
	},
	{
		id: "performance",
		label: "Performance",
		fields: [
			{
				id: "performance.mode",
				label: "Mode",
				description:
					"auto = honor env vars. lite = fast launch (no AST/kernel). full = everything on.",
				kind: "select",
				options: ["auto", "lite", "full"] as const,
				get: (s) => s.performance.mode,
				set: (s, v) => ({
					...s,
					performance: { ...s.performance, mode: v as Settings["performance"]["mode"] },
				}),
			},
			{
				id: "performance.introBanner",
				label: "Intro banner",
				description: "auto = honor env vars. on = always show. off = never show.",
				kind: "select",
				options: ["auto", "on", "off"] as const,
				get: (s) => s.performance.introBanner,
				set: (s, v) => ({
					...s,
					performance: {
						...s.performance,
						introBanner: v as Settings["performance"]["introBanner"],
					},
				}),
			},
		],
	},
	{
		id: "models",
		label: "Models",
		fields: [
			{
				id: "models.tabs.orchestrator.provider",
				label: "Orchestrator provider",
				description:
					"Provider for the Orchestrator tab (e.g. ollama, lmstudio, apfel, openrouter).",
				kind: "text",
				rule: PROVIDER_RULE,
				get: (s) => s.models.tabs.orchestrator.provider,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							orchestrator: { ...s.models.tabs.orchestrator, provider: String(v) },
						},
					},
				}),
			},
			{
				id: "models.tabs.orchestrator.model",
				label: "Orchestrator model",
				description: "Model id for the Orchestrator tab.",
				kind: "text",
				rule: MODEL_RULE,
				get: (s) => s.models.tabs.orchestrator.model,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							orchestrator: { ...s.models.tabs.orchestrator, model: String(v) },
						},
					},
				}),
			},
			{
				id: "models.tabs.engineer.provider",
				label: "Engineer provider",
				description: "Provider for the Engineer tab (e.g. ollama, lmstudio, apfel, openrouter).",
				kind: "text",
				rule: PROVIDER_RULE,
				get: (s) => s.models.tabs.engineer.provider,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							engineer: { ...s.models.tabs.engineer, provider: String(v) },
						},
					},
				}),
			},
			{
				id: "models.tabs.engineer.model",
				label: "Engineer model",
				description: "Model id for the Engineer tab.",
				kind: "text",
				rule: MODEL_RULE,
				get: (s) => s.models.tabs.engineer.model,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							engineer: { ...s.models.tabs.engineer, model: String(v) },
						},
					},
				}),
			},
			{
				id: "models.tabs.qa.provider",
				label: "QA provider",
				description: "Provider for the QA tab (e.g. ollama, lmstudio, apfel, openrouter).",
				kind: "text",
				rule: PROVIDER_RULE,
				get: (s) => s.models.tabs.qa.provider,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							qa: { ...s.models.tabs.qa, provider: String(v) },
						},
					},
				}),
			},
			{
				id: "models.tabs.qa.model",
				label: "QA model",
				description: "Model id for the QA tab.",
				kind: "text",
				rule: MODEL_RULE,
				get: (s) => s.models.tabs.qa.model,
				set: (s, v) => ({
					...s,
					models: {
						...s.models,
						tabs: {
							...s.models.tabs,
							qa: { ...s.models.tabs.qa, model: String(v) },
						},
					},
				}),
			},
		],
	},
	{
		id: "providers",
		label: "Providers",
		fields: [
			{
				id: "providers.apfel.baseURL",
				label: "Apfel baseURL",
				description: "Apple Foundation Model OpenAI-compatible endpoint.",
				kind: "text",
				rule: URL_RULE,
				get: (s) => s.providers.apfel.baseURL,
				set: (s, v) => ({
					...s,
					providers: { ...s.providers, apfel: { baseURL: String(v) } },
				}),
			},
			{
				id: "providers.ollama.baseURL",
				label: "Ollama baseURL",
				description: "Local Ollama endpoint.",
				kind: "text",
				rule: URL_RULE,
				get: (s) => s.providers.ollama.baseURL,
				set: (s, v) => ({
					...s,
					providers: { ...s.providers, ollama: { baseURL: String(v) } },
				}),
			},
			{
				id: "providers.lmstudio.baseURL",
				label: "LM Studio baseURL",
				description: "Local LM Studio endpoint.",
				kind: "text",
				rule: URL_RULE,
				get: (s) => s.providers.lmstudio.baseURL,
				set: (s, v) => ({
					...s,
					providers: { ...s.providers, lmstudio: { baseURL: String(v) } },
				}),
			},
			{
				id: "providers.openrouter.baseURL",
				label: "OpenRouter baseURL",
				description: "Cloud OpenRouter endpoint.",
				kind: "text",
				rule: URL_RULE,
				get: (s) => s.providers.openrouter.baseURL,
				set: (s, v) => ({
					...s,
					providers: { ...s.providers, openrouter: { baseURL: String(v) } },
				}),
			},
		],
	},
	{
		id: "ui",
		label: "UI",
		fields: [
			{
				id: "ui.theme",
				label: "Theme",
				description: "Reserved for future themes. Default amber.",
				kind: "text",
				rule: THEME_RULE,
				get: (s) => s.ui.theme,
				set: (s, v) => ({ ...s, ui: { ...s.ui, theme: String(v) } }),
			},
			{
				id: "ui.thinkingVisualiser.enabled",
				label: "Thinking Visualiser",
				description: "Procedural canvas inside the Thinking box. Disable for plain text.",
				kind: "toggle",
				get: (s) => s.ui.thinkingVisualiser.enabled,
				set: (s, v) => ({
					...s,
					ui: {
						...s.ui,
						thinkingVisualiser: { ...s.ui.thinkingVisualiser, enabled: Boolean(v) },
					},
				}),
			},
			{
				id: "ui.thinkingVisualiser.operatorRotationMs",
				label: "Operator rotation (ms)",
				description: "Interval before the visualiser swaps to a new operator. Range 1000-60000.",
				kind: "number",
				min: 1000,
				max: 60000,
				step: 500,
				get: (s) => s.ui.thinkingVisualiser.operatorRotationMs,
				set: (s, v) => ({
					...s,
					ui: {
						...s.ui,
						thinkingVisualiser: {
							...s.ui.thinkingVisualiser,
							operatorRotationMs: clampNumber(Number(v), 1000, 60000),
						},
					},
				}),
			},
			{
				id: "ui.thinkingVisualiser.boredomThresholdMs",
				label: "Boredom threshold (ms)",
				description: "Idle time before the visualiser mutates its parameters. Range 5000-600000.",
				kind: "number",
				min: 5000,
				max: 600000,
				step: 1000,
				get: (s) => s.ui.thinkingVisualiser.boredomThresholdMs,
				set: (s, v) => ({
					...s,
					ui: {
						...s.ui,
						thinkingVisualiser: {
							...s.ui.thinkingVisualiser,
							boredomThresholdMs: clampNumber(Number(v), 5000, 600000),
						},
					},
				}),
			},
		],
	},
];

// ----------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ----------------------------------------------------------------------------

/** Gap between the end of the longest label and the value column. */
const LABEL_GAP = 2;

/**
 * Width of the shared label column: the longest label plus a fixed gap. Every
 * row pads its label to this width so values line up whether or not the row
 * is selected, and the column does not shift when the category changes.
 */
export function labelColumnWidth(fields: readonly { label: string }[]): number {
	let longest = 0;
	for (const f of fields) longest = Math.max(longest, f.label.length);
	return longest + LABEL_GAP;
}

/** Pad a label to the shared column width. Labels longer than the width are kept whole. */
export function padLabel(label: string, width: number): string {
	return label.padEnd(width, " ");
}

export const LABEL_COLUMN_WIDTH = labelColumnWidth(SETTINGS_CATEGORIES.flatMap((c) => c.fields));

/** Display string for a stored value. Toggles render as checkboxes. */
export function formatValue(field: Field, value: unknown): string {
	if (field.kind === "toggle") return value ? "[x]" : "[ ]";
	return String(value ?? "");
}

/** The text a user starts editing from: the raw stored value, never checkbox framing. */
export function editSeed(value: unknown): string {
	return String(value ?? "");
}

/** Validate typed input for a field. Toggle and select never reach here. */
export function validateFieldInput(
	field: Field,
	raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
	if (field.kind === "number") {
		return validateNumber(raw, { min: field.min, max: field.max });
	}
	if (field.kind === "text") {
		return validateText(raw, field.rule);
	}
	return { ok: true, value: raw };
}

/** Footer hint for a row in browse mode. Only mentions Left/Right where they act. */
export function browseHint(field: Field | undefined): string {
	const tail = "tab category  ? help  q close";
	if (!field) return `up/down navigate  ${tail}`;
	switch (field.kind) {
		case "toggle":
			return `up/down navigate  space toggle  ${tail}`;
		case "select":
			return `up/down navigate  left/right cycle  ${tail}`;
		case "number":
			return `up/down navigate  left/right adjust by ${field.step}  e edit  ${tail}`;
		case "text":
			return `up/down navigate  e edit  ${tail}`;
	}
}

/** Footer hint while editing. Changes once the selection collapses to a cursor. */
export function editHint(field: Field, state: EditState): string {
	const rule =
		field.kind === "number"
			? `${field.min}-${field.max}`
			: field.kind === "text" && field.rule.kind === "url"
				? "http(s) URL"
				: null;
	const ruleText = rule ? `  (${rule})` : "";
	if (state.selectAll) {
		return `Editing ${field.label}${ruleText}  type to replace  left/right edit in place  Enter save  Esc cancel`;
	}
	return `Editing ${field.label}${ruleText}  type to insert  left/right move  Enter save  Esc cancel`;
}

// ----------------------------------------------------------------------------
// Edit-buffer state machine (exported for tests)
// ----------------------------------------------------------------------------

export interface EditState {
	buffer: string;
	/** Insertion point, 0..buffer.length. Ignored while selectAll is true. */
	cursor: number;
	/** True on entry: the whole value is selected and the next character replaces it. */
	selectAll: boolean;
	/** Validation message from the last rejected commit, or null. */
	error: string | null;
}

export type EditKey =
	| { type: "char"; text: string }
	| { type: "backspace" }
	| { type: "left" }
	| { type: "right" }
	| { type: "home" }
	| { type: "end" };

export function beginEditState(seed: string): EditState {
	return { buffer: seed, cursor: seed.length, selectAll: true, error: null };
}

export function editReducer(state: EditState, key: EditKey): EditState {
	const { buffer, cursor, selectAll } = state;
	switch (key.type) {
		case "char": {
			if (selectAll) {
				return { buffer: key.text, cursor: key.text.length, selectAll: false, error: null };
			}
			const next = buffer.slice(0, cursor) + key.text + buffer.slice(cursor);
			return { buffer: next, cursor: cursor + key.text.length, selectAll: false, error: null };
		}
		case "backspace": {
			if (selectAll) return { buffer: "", cursor: 0, selectAll: false, error: null };
			if (cursor === 0) return { ...state, error: null };
			const next = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
			return { buffer: next, cursor: cursor - 1, selectAll: false, error: null };
		}
		case "left": {
			if (selectAll) {
				return { buffer, cursor: Math.max(0, buffer.length - 1), selectAll: false, error: null };
			}
			return { ...state, cursor: Math.max(0, cursor - 1), error: null };
		}
		case "right": {
			if (selectAll) return { buffer, cursor: buffer.length, selectAll: false, error: null };
			return { ...state, cursor: Math.min(buffer.length, cursor + 1), error: null };
		}
		case "home":
			return { buffer, cursor: 0, selectAll: false, error: null };
		case "end":
			return { buffer, cursor: buffer.length, selectAll: false, error: null };
	}
}

/** Split an edit buffer into the three segments the renderer highlights. */
export function editSegments(state: EditState): { before: string; at: string; after: string } {
	if (state.selectAll) return { before: "", at: state.buffer || " ", after: "" };
	const { buffer, cursor } = state;
	return {
		before: buffer.slice(0, cursor),
		at: buffer.charAt(cursor) || " ",
		after: buffer.slice(cursor + 1),
	};
}

/** Settings file path with the home directory collapsed to "~" for the header. */
export function displaySettingsPath(filePath: string, home: string): string {
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

/** Help overlay rows: [keys, what they do]. Rendered with a shared key column. */
export const HELP_ROWS: readonly (readonly [string, string])[] = [
	["Up/Down", "Move between fields and categories"],
	["Tab / Shift+Tab", "Next / previous category"],
	["Space / Enter", "Toggle a boolean, or cycle a select forward"],
	["Left/Right", "Cycle a select, or adjust a number by its step"],
	["e / Enter", "Edit a text or number field (whole value selected)"],
	["  typing", "Replaces the selected value"],
	["  Left/Right", "Edit in place; Home/End jump to either end"],
	["  Enter", "Save (invalid input shows the rule and stays in edit)"],
	["  Esc", "Cancel the edit"],
	["Esc / q", "Close the view"],
	["?", "Show this help"],
];

export const HELP_KEY_WIDTH = labelColumnWidth(HELP_ROWS.map(([keys]) => ({ label: keys })));

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

interface SettingsViewProps {
	visible: boolean;
	onClose: () => void;
}

type Mode = "browse" | "edit";
type SaveState = "idle" | "pending" | "saved";

const SAVE_DEBOUNCE_MS = 500;
const SAVED_FLASH_MS = 2000;

// Splitting this component changes prop surface and file structure; tracked separately from the lint sweep.
// Multiple useState calls model independent slices with different update sources; a reducer would conflate orthogonal events.
// react-doctor-disable-next-line react-doctor/no-giant-component
// react-doctor-disable-next-line react-doctor/prefer-useReducer
export function SettingsView({ visible, onClose }: SettingsViewProps) {
	const [settings, setSettings] = useState<Settings>(() => loadSettings());
	const [categoryIndex, setCategoryIndex] = useState(0);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [mode, setMode] = useState<Mode>("browse");
	const [edit, setEdit] = useState<EditState>(() => beginEditState(""));
	// State value is read in render or feeds a derived value used in render; useRef would break visible output.
	// react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
	const [showHelp, setShowHelp] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	// Latest committed settings, readable from timers and the unmount flush
	// without stale closures.
	const settingsRef = useRef(settings);
	const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	const category = SETTINGS_CATEGORIES[categoryIndex];
	const field = category?.fields[fieldIndex];

	const settingsPath = useMemo(() => displaySettingsPath(getSettingsFilePath(), os.homedir()), []);

	// Debounced persistence. Only ever called after a real change, so opening
	// the view never touches the file.
	const scheduleSave = useCallback((next: Settings) => {
		if (saveTimeout.current) clearTimeout(saveTimeout.current);
		if (flashTimeout.current) clearTimeout(flashTimeout.current);
		setSaveState("pending");
		saveTimeout.current = setTimeout(() => {
			saveTimeout.current = null;
			saveSettings(next);
			setSaveState("saved");
			flashTimeout.current = setTimeout(() => {
				flashTimeout.current = null;
				setSaveState("idle");
			}, SAVED_FLASH_MS);
		}, SAVE_DEBOUNCE_MS);
	}, []);

	// Flush a pending write on unmount so a quick close never loses a change.
	useEffect(() => {
		return () => {
			if (flashTimeout.current) clearTimeout(flashTimeout.current);
			if (saveTimeout.current) {
				clearTimeout(saveTimeout.current);
				saveTimeout.current = null;
				saveSettings(settingsRef.current);
			}
		};
	}, []);

	// Reset edit state if view becomes hidden
	useEffect(() => {
		if (!visible && mode !== "browse") {
			setMode("browse");
			setEdit(beginEditState(""));
		}
	}, [visible, mode]);

	// Clamp indices when category changes
	useEffect(() => {
		const cat = SETTINGS_CATEGORIES[categoryIndex];
		if (cat && fieldIndex >= cat.fields.length) {
			setFieldIndex(Math.max(0, cat.fields.length - 1));
		}
	}, [categoryIndex, fieldIndex]);

	const updateField = useCallback(
		(f: Field, value: unknown) => {
			const next = f.set(settingsRef.current, value);
			settingsRef.current = next;
			setSettings(next);
			scheduleSave(next);
		},
		[scheduleSave],
	);

	const beginEdit = useCallback((f: Field) => {
		setEdit(beginEditState(editSeed(f.get(settingsRef.current))));
		setMode("edit");
	}, []);

	const commitEdit = useCallback(() => {
		if (!field) {
			setMode("browse");
			return;
		}
		const result = validateFieldInput(field, edit.buffer);
		if (!result.ok) {
			// Keep the buffer and cursor so the user can correct in place.
			setEdit((prev) => ({ ...prev, selectAll: false, error: result.message }));
			return;
		}
		if (result.value !== field.get(settingsRef.current)) {
			updateField(field, result.value);
		}
		setMode("browse");
		setEdit(beginEditState(""));
	}, [field, edit.buffer, updateField]);

	const cancelEdit = useCallback(() => {
		setMode("browse");
		setEdit(beginEditState(""));
	}, []);

	const moveCategory = useCallback((delta: number) => {
		setCategoryIndex((prev) => {
			const n = SETTINGS_CATEGORIES.length;
			return (prev + delta + n) % n;
		});
		setFieldIndex(0);
	}, []);

	useInput(
		(input, key) => {
			// Help overlay swallows all input except dismiss
			if (showHelp) {
				if (input === "?" || key.escape || input === "q") setShowHelp(false);
				return;
			}

			// EDIT mode (text or number): keystrokes feed the edit buffer
			if (mode === "edit") {
				if (key.return) {
					commitEdit();
					return;
				}
				if (key.escape) {
					cancelEdit();
					return;
				}
				if (key.backspace || key.delete) {
					setEdit((prev) => editReducer(prev, { type: "backspace" }));
					return;
				}
				if (key.leftArrow) {
					setEdit((prev) => editReducer(prev, { type: "left" }));
					return;
				}
				if (key.rightArrow) {
					setEdit((prev) => editReducer(prev, { type: "right" }));
					return;
				}
				if (key.home) {
					setEdit((prev) => editReducer(prev, { type: "home" }));
					return;
				}
				if (key.end) {
					setEdit((prev) => editReducer(prev, { type: "end" }));
					return;
				}
				if (key.upArrow || key.downArrow || key.tab) return;
				if (input && !key.ctrl && !key.meta) {
					setEdit((prev) => editReducer(prev, { type: "char", text: input }));
					return;
				}
				return;
			}

			// BROWSE mode

			if (input === "?") {
				setShowHelp(true);
				return;
			}

			if (key.escape || input === "q") {
				onClose();
				return;
			}

			// Tab / Shift+Tab cycle categories
			if (key.tab) {
				moveCategory(key.shift ? -1 : 1);
				return;
			}

			// Up/down: walk fields, spilling into the neighbouring category
			if (key.upArrow) {
				if (fieldIndex === 0) {
					if (categoryIndex > 0) {
						const prevCat = SETTINGS_CATEGORIES[categoryIndex - 1];
						setCategoryIndex(categoryIndex - 1);
						setFieldIndex(Math.max(0, (prevCat?.fields.length ?? 1) - 1));
					}
				} else {
					setFieldIndex((prev) => Math.max(0, prev - 1));
				}
				return;
			}
			if (key.downArrow) {
				if (category && fieldIndex >= category.fields.length - 1) {
					if (categoryIndex < SETTINGS_CATEGORIES.length - 1) {
						setCategoryIndex(categoryIndex + 1);
						setFieldIndex(0);
					}
				} else {
					setFieldIndex((prev) => prev + 1);
				}
				return;
			}

			if (!field) return;

			// Field interactions
			if (field.kind === "toggle") {
				if (input === " " || key.return) {
					updateField(field, !field.get(settingsRef.current));
				}
				return;
			}

			if (field.kind === "select") {
				const current = String(field.get(settingsRef.current));
				const idx = Math.max(0, field.options.indexOf(current));
				const n = field.options.length;
				if (key.leftArrow) {
					updateField(field, field.options[(idx - 1 + n) % n]);
					return;
				}
				if (key.rightArrow || input === " " || key.return) {
					updateField(field, field.options[(idx + 1) % n]);
					return;
				}
				return;
			}

			if (field.kind === "number") {
				const current = Number(field.get(settingsRef.current));
				if (key.leftArrow || key.rightArrow) {
					const delta = key.leftArrow ? -field.step : field.step;
					const next = clampNumber(current + delta, field.min, field.max);
					if (next !== current) updateField(field, next);
					return;
				}
				if (key.return || input === "e") {
					beginEdit(field);
					return;
				}
				return;
			}

			if (field.kind === "text") {
				if (key.return || input === "e") {
					beginEdit(field);
					return;
				}
				return;
			}
		},
		{ isActive: visible },
	);

	if (!visible) return null;

	// Help overlay
	if (showHelp) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Box marginBottom={1}>
					<Heading>Settings - Help</Heading>
				</Box>
				<Divider />
				<Box flexDirection="column" paddingY={1}>
					{HELP_ROWS.map(([keys, what]) => (
						<AppText key={keys}>
							{padLabel(keys, HELP_KEY_WIDTH)}
							{what}
						</AppText>
					))}
				</Box>
				<Divider />
				<MutedText>Press ? or Esc to dismiss</MutedText>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Heading>Settings</Heading>
				<MutedText>
					{"  "}
					{settingsPath}
				</MutedText>
				{saveState === "pending" ? <MutedText>{"  "}saving</MutedText> : null}
				{saveState === "saved" ? <SuccessText>{"  "}saved</SuccessText> : null}
			</Box>

			<Divider />

			<Box flexDirection="row" paddingY={1}>
				{/* Left column: categories */}
				<Box flexDirection="column" width={20} marginRight={2}>
					<Text bold color={t.orange}>
						Categories
					</Text>
					<Box marginTop={1} flexDirection="column">
						{SETTINGS_CATEGORIES.map((c, i) => (
							<Box key={c.id}>
								<Text color={i === categoryIndex ? t.orange : undefined}>
									{i === categoryIndex ? ">" : " "}{" "}
								</Text>
								<AppText bold={i === categoryIndex}>{c.label}</AppText>
							</Box>
						))}
					</Box>
				</Box>

				{/* Right column: fields */}
				<Box flexDirection="column" flexGrow={1}>
					<Text bold color={t.orange}>
						{category?.label || ""}
					</Text>
					<Box marginTop={1} flexDirection="column">
						<Stack>
							{(category?.fields || []).map((f, i) => {
								const selected = i === fieldIndex;
								const editing = mode === "edit" && selected;
								const segments = editing ? editSegments(edit) : null;
								return (
									<Box key={f.id} flexDirection="column" marginBottom={1}>
										<Box>
											<Text color={selected ? t.orange : undefined}>{selected ? ">" : " "} </Text>
											<AppText bold={selected}>{padLabel(f.label, LABEL_COLUMN_WIDTH)}</AppText>
											{segments ? (
												<>
													<Text color={t.teal}>{segments.before}</Text>
													<Text color={t.teal} inverse>
														{segments.at}
													</Text>
													<Text color={t.teal}>{segments.after}</Text>
												</>
											) : (
												<Text color={t.teal}>{formatValue(f, f.get(settings))}</Text>
											)}
										</Box>
										{selected ? (
											<Box marginLeft={2}>
												{editing && edit.error ? (
													<ErrorText>{edit.error}</ErrorText>
												) : (
													<MutedText>{f.description}</MutedText>
												)}
											</Box>
										) : null}
									</Box>
								);
							})}
						</Stack>
					</Box>
				</Box>
			</Box>

			<Divider />

			{mode === "edit" && field ? (
				<MutedText>{editHint(field, edit)}</MutedText>
			) : (
				<MutedText>{browseHint(field)}</MutedText>
			)}
		</Box>
	);
}
