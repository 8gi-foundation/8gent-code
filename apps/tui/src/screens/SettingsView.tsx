/**
 * 8gent Code - Settings View
 *
 * In-TUI settings editor backed by @8gent/settings.
 * Categories on the left, widgets on the right.
 *
 * Widgets:
 *   - toggle  (boolean)        space to flip
 *   - text    (string)         type to edit, Enter to commit
 *   - number  (number)         up/down arrows or type, clamped to range
 *   - select  (enum string[])  left/right arrows to cycle
 *
 * Persistence: live save to ~/.8gent/settings.json on every commit, debounced 500ms.
 * Mirrors the NotesView "tab takeover" shape for consistency with other utility tabs.
 */

import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	loadSettings,
	saveSettings,
	type Settings,
} from "../../../../packages/settings/index.js";
import { AppText, Divider, Heading, MutedText, Stack } from "../components/primitives/index.js";

// ----------------------------------------------------------------------------
// Field descriptors
// ----------------------------------------------------------------------------

type FieldKind = "toggle" | "text" | "number" | "select";

interface BaseField {
	id: string;
	label: string;
	description: string;
	kind: FieldKind;
	get: (s: Settings) => unknown;
	set: (s: Settings, value: unknown) => Settings;
}

interface NumberField extends BaseField {
	kind: "number";
	min: number;
	max: number;
	step: number;
}

interface SelectField extends BaseField {
	kind: "select";
	options: readonly string[];
}

type Field = BaseField | NumberField | SelectField;

interface Category {
	id: string;
	label: string;
	fields: Field[];
}

const CATEGORIES: Category[] = [
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
					voice: { ...s.voice, silenceThresholdMs: Number(v) },
				}),
			} as NumberField,
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
				description: "macOS voice name used when a tab has no per-agent voice (e.g. Ava, Samantha, Daniel).",
				kind: "text",
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
			} as SelectField,
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
			} as SelectField,
		],
	},
	{
		id: "models",
		label: "Models",
		fields: [
			{
				id: "models.tabs.orchestrator.provider",
				label: "Orchestrator provider",
				description: "Provider for the Orchestrator tab.",
				kind: "text",
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
				description: "Provider for the Engineer tab.",
				kind: "text",
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
				description: "Provider for the QA tab.",
				kind: "text",
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
				description: "Interval before the visualiser swaps to a new operator.",
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
				description: "Idle time before the visualiser mutates its parameters.",
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
// Helpers
// ----------------------------------------------------------------------------

function clampNumber(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function formatValue(field: Field, value: unknown): string {
	if (field.kind === "toggle") return value ? "on" : "off";
	if (field.kind === "number") return String(value);
	return String(value ?? "");
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

interface SettingsViewProps {
	visible: boolean;
	onClose: () => void;
}

type Mode = "browse" | "edit";

export function SettingsView({ visible, onClose }: SettingsViewProps) {
	const [settings, setSettings] = useState<Settings>(() => loadSettings());
	const [categoryIndex, setCategoryIndex] = useState(0);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [mode, setMode] = useState<Mode>("browse");
	const [editBuffer, setEditBuffer] = useState("");
	const [showHelp, setShowHelp] = useState(false);

	const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	const category = CATEGORIES[categoryIndex];
	const field = category?.fields[fieldIndex];

	// Debounced persistence on every settings change
	const scheduleSave = useCallback((next: Settings) => {
		if (saveTimeout.current) clearTimeout(saveTimeout.current);
		saveTimeout.current = setTimeout(() => saveSettings(next), 500);
	}, []);

	useEffect(() => {
		scheduleSave(settings);
	}, [settings, scheduleSave]);

	// Flush on unmount
	useEffect(() => {
		return () => {
			if (saveTimeout.current) {
				clearTimeout(saveTimeout.current);
				saveSettings(settings);
			}
		};
	}, [settings]);

	// Reset edit state if view becomes hidden
	useEffect(() => {
		if (!visible && mode !== "browse") {
			setMode("browse");
			setEditBuffer("");
		}
	}, [visible, mode]);

	// Clamp indices when category changes
	useEffect(() => {
		const cat = CATEGORIES[categoryIndex];
		if (cat && fieldIndex >= cat.fields.length) {
			setFieldIndex(Math.max(0, cat.fields.length - 1));
		}
	}, [categoryIndex, fieldIndex]);

	const updateField = useCallback(
		(f: Field, value: unknown) => {
			setSettings((prev) => f.set(prev, value));
		},
		[],
	);

	const beginEdit = useCallback((f: Field) => {
		const current = formatValue(f, f.get(loadSettings()));
		setEditBuffer(current);
		setMode("edit");
	}, []);

	const commitEdit = useCallback(() => {
		if (!field) {
			setMode("browse");
			return;
		}
		if (field.kind === "number") {
			const nf = field as NumberField;
			const parsed = Number.parseFloat(editBuffer);
			const clamped = clampNumber(parsed, nf.min, nf.max);
			updateField(field, clamped);
		} else {
			updateField(field, editBuffer);
		}
		setMode("browse");
		setEditBuffer("");
	}, [field, editBuffer, updateField]);

	const cancelEdit = useCallback(() => {
		setMode("browse");
		setEditBuffer("");
	}, []);

	useInput(
		(input, key) => {
			// Help overlay swallows all input except dismiss
			if (showHelp) {
				if (input === "?" || key.escape || input === "q") setShowHelp(false);
				return;
			}

			// EDIT mode (text or number): keystrokes feed editBuffer
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
					setEditBuffer((prev) => prev.slice(0, -1));
					return;
				}
				if (input && !key.ctrl && !key.meta) {
					setEditBuffer((prev) => prev + input);
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

			// Left/right: switch category
			if (key.leftArrow && !field) {
				setCategoryIndex((prev) => Math.max(0, prev - 1));
				return;
			}
			if (key.rightArrow && !field) {
				setCategoryIndex((prev) => Math.min(CATEGORIES.length - 1, prev + 1));
				return;
			}

			// Up/down: walk fields within category
			if (key.upArrow) {
				if (fieldIndex === 0) {
					setCategoryIndex((prev) => {
						const next = Math.max(0, prev - 1);
						setFieldIndex(Math.max(0, (CATEGORIES[next]?.fields.length || 1) - 1));
						return next;
					});
				} else {
					setFieldIndex((prev) => Math.max(0, prev - 1));
				}
				return;
			}
			if (key.downArrow) {
				if (category && fieldIndex >= category.fields.length - 1) {
					setCategoryIndex((prev) => {
						const next = Math.min(CATEGORIES.length - 1, prev + 1);
						setFieldIndex(0);
						return next;
					});
				} else {
					setFieldIndex((prev) => prev + 1);
				}
				return;
			}

			if (!field) return;

			// Tab cycles categories
			if (key.tab) {
				setCategoryIndex((prev) => (prev + 1) % CATEGORIES.length);
				setFieldIndex(0);
				return;
			}

			// Field interactions
			if (field.kind === "toggle") {
				if (input === " " || key.return) {
					updateField(field, !field.get(settings));
				}
				return;
			}

			if (field.kind === "select") {
				const sf = field as SelectField;
				const current = String(sf.get(settings));
				const idx = sf.options.indexOf(current);
				if (key.leftArrow) {
					const next = sf.options[(idx - 1 + sf.options.length) % sf.options.length];
					updateField(sf, next);
					return;
				}
				if (key.rightArrow || input === " " || key.return) {
					const next = sf.options[(idx + 1) % sf.options.length];
					updateField(sf, next);
					return;
				}
				return;
			}

			if (field.kind === "number") {
				const nf = field as NumberField;
				const current = Number(nf.get(settings));
				if (key.leftArrow) {
					updateField(nf, clampNumber(current - nf.step, nf.min, nf.max));
					return;
				}
				if (key.rightArrow) {
					updateField(nf, clampNumber(current + nf.step, nf.min, nf.max));
					return;
				}
				if (key.return || input === "e") {
					beginEdit(nf);
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
					<AppText>Up/Down       Move between fields and categories</AppText>
					<AppText>Left/Right    Cycle select values, or adjust numbers by step</AppText>
					<AppText>Tab           Next category</AppText>
					<AppText>Space / Enter Toggle a boolean, or cycle a select</AppText>
					<AppText>e / Enter     Edit a text or number field</AppText>
					<AppText>Esc           Cancel an edit, or close the view</AppText>
					<AppText>q             Close the view</AppText>
					<AppText>?             Show this help</AppText>
				</Box>
				<Divider />
				<MutedText>Press ? or Esc to dismiss</MutedText>
			</Box>
		);
	}

	const valueDisplay = field ? formatValue(field, field.get(settings)) : "";

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Heading>Settings</Heading>
				<MutedText>
					{"  "}~/.8gent/settings.json - {CATEGORIES.length} categor
					{CATEGORIES.length === 1 ? "y" : "ies"}
				</MutedText>
			</Box>

			<Divider />

			<Box flexDirection="row" paddingY={1}>
				{/* Left column: categories */}
				<Box flexDirection="column" width={20} marginRight={2}>
					<Text bold color="yellow">
						Categories
					</Text>
					<Box marginTop={1} flexDirection="column">
						{CATEGORIES.map((c, i) => (
							<Box key={c.id}>
								<Text color={i === categoryIndex ? "yellow" : undefined}>
									{i === categoryIndex ? ">" : " "}{" "}
								</Text>
								<AppText bold={i === categoryIndex}>{c.label}</AppText>
							</Box>
						))}
					</Box>
				</Box>

				{/* Right column: fields */}
				<Box flexDirection="column" flexGrow={1}>
					<Text bold color="yellow">
						{category?.label || ""}
					</Text>
					<Box marginTop={1} flexDirection="column">
						<Stack>
							{(category?.fields || []).map((f, i) => {
								const selected = i === fieldIndex;
								const display =
									mode === "edit" && selected
										? `${editBuffer}_`
										: formatValue(f, f.get(settings));
								return (
									<Box key={f.id} flexDirection="column" marginBottom={1}>
										<Box>
											<Text color={selected ? "yellow" : undefined}>
												{selected ? ">" : " "}{" "}
											</Text>
											<AppText bold={selected}>{f.label}</AppText>
											<Box flexGrow={1} />
											<Text color="cyan">
												{f.kind === "toggle"
													? display === "on"
														? "[x]"
														: "[ ]"
													: display}
											</Text>
										</Box>
										{selected ? (
											<Box marginLeft={3}>
												<MutedText>{f.description}</MutedText>
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

			{mode === "edit" ? (
				<MutedText>
					Editing {field?.label || ""} - type to change, Enter to save, Esc to cancel
				</MutedText>
			) : (
				<MutedText>
					arrows=navigate space=toggle/cycle e=edit ? =help q=close - current: {valueDisplay}
				</MutedText>
			)}
		</Box>
	);
}
