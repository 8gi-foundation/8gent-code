/**
 * 8gent Code - Animated Command Input Component
 *
 * Features:
 * - Animated spinner with status text
 * - Pulsing prompt when idle
 * - Step indicator for multi-step operations
 * - Ghost text suggestions (Tab to accept)
 * - Slash command support (/kanban, /predict, /avenues)
 */

import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
	type ContextSuggestion,
	getSuggestionSourceLabel,
	useGhostSuggestion,
} from "../hooks/use-ghost-suggestion.js";
import type { SlashCommand } from "../lib/slash-commands.js";
import {
	type SlashRegistryEntry,
	getBuiltInSlashCommands,
	getSlashRegistry,
	resolveSlashInput,
	toGhostSuggestions,
} from "../lib/slash-registry.js";
import {
	GO_HELP_LINES,
	type GoalClient,
	parseGoCommand,
} from "../lib/goal-client.js";
import { padRight, truncate } from "../lib/text.js";
import { t } from "../theme.js";
import { AnimatedSpinner, StatusIndicator, StepIndicator } from "./animated-spinner.js";
import { Blink } from "./fade-transition.js";
import { AppText, Label, MutedText } from "./primitives/AppText.js";
import { Inline } from "./primitives/Inline.js";
import { ShortcutHint } from "./primitives/ShortcutHint.js";
import { WaveProgress } from "./progress-bar.js";

// Stable empty-array defaults so prop = EMPTY_X doesn't allocate per render.
const EMPTY_RECENT: string[] = [];
const EMPTY_SUGGESTIONS: string[] = [];

interface CommandInputProps {
	onSubmit: (input: string) => void;
	isProcessing: boolean;
	processingStage?: "planning" | "toolshed" | "executing" | "complete";
	showAnimations?: boolean;
	// Real-time agent progress
	activeTool?: string | null;
	stepCount?: number;
	toolCount?: number;
	totalTokens?: number;
	// Ghost suggestion options
	isGitRepo?: boolean;
	currentBranch?: string | null;
	planNextStep?: string | null;
	recentCommands?: string[];
	// Slash command handlers
	onSlashCommand?: (command: SlashCommand, args: string[]) => void;
	/** Optional /goal client. When present, /goal and /subgoal are handled in
	 *  this component (daemon RPC dispatched directly) instead of bubbling
	 *  up to onSlashCommand. Keeps the goal protocol localized to one file. */
	goalClient?: GoalClient | null;
	/** Current session id, used for goal.start. Defaults to "tui" if absent. */
	sessionId?: string;
	/** Hook for surfacing system-line messages without coupling to app.tsx. */
	onSystemMessage?: (line: string) => void;
	/** Text injected from voice transcription — appended to current input for review */
	injectedText?: string | null;
	/** Whether the input is focused (false when non-chat views are active) */
	focused?: boolean;
	/** Rewrite the input on each change (e.g. consume a lone pasted file path into an attachment) */
	transformInputValue?: (value: string) => string;
	/** When true, Enter with an empty line still calls onSubmit (for empty send) */
	allowEmptySubmit?: boolean;
	/**
	 * Width of the column this input lives in, border included. The slash
	 * autocomplete box sizes itself to this so it never paints outside the
	 * column. See lib/layout popupLayout.
	 */
	popupWidth?: number;
	/** Maximum entries the slash autocomplete box lists at once. */
	popupRows?: number;
}

/** Fallback column width when the caller does not measure one. */
const DEFAULT_POPUP_WIDTH = 60;
/** Fallback slash autocomplete row budget. */
const DEFAULT_POPUP_ROWS = 14;

// Processing stages for multi-step indicator
const PROCESSING_STAGES = ["Plan", "Tools", "Execute"];

function buildBuiltInSlashGhostSuggestions(): ContextSuggestion[] {
	const out: ContextSuggestion[] = [];
	for (const cmd of getBuiltInSlashCommands()) {
		out.push({ trigger: `/${cmd.name}`, suggestion: "", confidence: 0.87 });
		for (const a of cmd.aliases) {
			if (a.length < 1) continue;
			out.push({ trigger: `/${a}`, suggestion: "", confidence: 0.83 });
		}
	}
	return out.sort((a, b) => b.trigger.length - a.trigger.length);
}

// ============================================
// Main Command Input
// ============================================

export function CommandInput({
	onSubmit,
	isProcessing,
	processingStage = "planning",
	showAnimations = true,
	activeTool = null,
	stepCount = 0,
	toolCount = 0,
	totalTokens = 0,
	isGitRepo = false,
	currentBranch = null,
	planNextStep = null,
	recentCommands = EMPTY_RECENT,
	onSlashCommand,
	goalClient = null,
	sessionId = "tui",
	onSystemMessage,
	injectedText = null,
	focused = true,
	transformInputValue,
	allowEmptySubmit = false,
	popupWidth = DEFAULT_POPUP_WIDTH,
	popupRows = DEFAULT_POPUP_ROWS,
// Multiple useState calls model independent slices with different update sources; a reducer would conflate orthogonal events.
// react-doctor-disable-next-line react-doctor/prefer-useReducer
}: CommandInputProps) {
	const [value, setValue] = useState("");
	// Value as of the last render, so a Ctrl chord can restore it. The
	// underlying TextInput inserts the chord's letter as text (Ctrl+P types
	// "p", Ctrl+U types "u") because it only filters Ctrl+C; we undo that
	// here, and Ctrl+U additionally clears the line.
	const valueRef = useRef("");
	valueRef.current = value;
	// Non-null while a Ctrl chord is being swallowed. TextInput's onChange
	// for the same keystroke sees this and restores instead of inserting.
	// Cleared on a microtask, after every listener for the keystroke ran.
	const restoreRef = useRef<string | null>(null);
	// History navigation: -1 = at draft (bottom), 0..N-1 = index into recentCommands
	const [historyIndex, setHistoryIndex] = useState(-1);
	const draftRef = useRef("");
	const [promptPulse, setPromptPulse] = useState(true);
	const [showSlashHelp, setShowSlashHelp] = useState(false);
	const [slashRegistryEntries, setSlashRegistryEntries] = useState<SlashRegistryEntry[]>([]);
	const [slashByToken, setSlashByToken] = useState<Map<string, SlashRegistryEntry>>(new Map());

	const builtInSlashGhosts = useMemo(() => buildBuiltInSlashGhostSuggestions(), []);
	const extraSlashContext = useMemo(
		() => [
			...builtInSlashGhosts,
			...toGhostSuggestions({
				entries: slashRegistryEntries,
				byToken: slashByToken,
			}),
		],
		[builtInSlashGhosts, slashRegistryEntries, slashByToken],
	);

	// Inject text from voice transcription (appends to current input)
	const lastInjectedRef = useRef<string | null>(null);
	useEffect(() => {
		if (injectedText && injectedText !== lastInjectedRef.current) {
			lastInjectedRef.current = injectedText;
			setValue((prev) => (prev ? `${prev} ${injectedText}` : injectedText));
		}
	}, [injectedText]);

	// Cascading set-state is intentional sequencing across distinct event classes; consolidating to a reducer would lose per-event identity.
	// react-doctor-disable-next-line react-doctor/no-cascading-set-state
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const registry = await getSlashRegistry();
				if (cancelled) return;
				setSlashRegistryEntries(registry.entries);
				setSlashByToken(registry.byToken);
			} catch {
				if (!cancelled) {
					setSlashRegistryEntries([]);
					setSlashByToken(new Map());
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Ghost suggestion hook
	const { suggestion, accept, dismiss, isVisible } = useGhostSuggestion(value, {
		isGitRepo,
		currentBranch,
		planNextStep,
		recentCommands,
		extraContextSuggestions: extraSlashContext,
	});

	// Pulsing prompt animation when idle
	useEffect(() => {
		if (isProcessing) return;

		const interval = setInterval(() => {
			setPromptPulse((prev) => !prev);
		}, 800);

		return () => clearInterval(interval);
	}, [isProcessing]);

	// Slash palette: show while typing the command token (no space yet) so long names like /billiondollarboardroom work
	useEffect(() => {
		const t = value.trimStart();
		setShowSlashHelp(t.startsWith("/") && !t.slice(1).includes(" "));
	}, [value]);

	// Handle keyboard input
	useInput(
		(input, key) => {
			// Ctrl chords are never text. Ctrl+U clears the line; any other
			// chord (Ctrl+P palette, Ctrl+N notes, ...) leaves the line as it
			// was. The app-level handler still receives the chord.
			if (key.ctrl && !key.meta && input.length === 1) {
				const restored = input === "u" ? "" : valueRef.current;
				restoreRef.current = restored;
				queueMicrotask(() => {
					restoreRef.current = null;
				});
				setValue(restored);
				if (input === "u") {
					setHistoryIndex(-1);
					draftRef.current = "";
				}
				return;
			}

			if (isProcessing) return;

			// Tab to accept ghost suggestion
			if (key.tab && isVisible && suggestion) {
				const newValue = accept();
				setValue(newValue);
				return;
			}

			// Escape to dismiss suggestion
			if (key.escape && isVisible) {
				dismiss();
				return;
			}

			// Up arrow: navigate to older history entry
			if (key.upArrow && recentCommands.length > 0) {
				const nextIndex = historyIndex < recentCommands.length - 1 ? historyIndex + 1 : historyIndex;
				if (nextIndex !== historyIndex) {
					if (historyIndex === -1) draftRef.current = value;
					setHistoryIndex(nextIndex);
					setValue(recentCommands[nextIndex] ?? "");
				}
				return;
			}

			// Down arrow: navigate to newer entry or restore draft
			if (key.downArrow && historyIndex >= 0) {
				const nextIndex = historyIndex - 1;
				setHistoryIndex(nextIndex);
				setValue(nextIndex < 0 ? draftRef.current : (recentCommands[nextIndex] ?? ""));
				return;
			}
		},
		{ isActive: focused },
	);

	const ghostVisible = !isProcessing && isVisible && Boolean(suggestion);

	const handleSubmit = useCallback(
		(input: string) => {
			const trimmed = input.trim();
			if (!trimmed && !allowEmptySubmit) return;

			// Reset history navigation on submit
			setHistoryIndex(-1);
			draftRef.current = "";

			// Check for slash command
			if (trimmed.startsWith("/")) {
				const resolved = resolveSlashInput(input, {
					entries: slashRegistryEntries,
					byToken: slashByToken,
				});

				// /goal and /subgoal: handled in-component when a GoalClient is
				// wired in. Falls through to onSlashCommand otherwise so the
				// app can render a clean "goal loop not connected" message.
				if (
					resolved?.entry.kind === "builtin" &&
					(resolved.entry.builtInName === "goal" ||
						resolved.entry.builtInName === "subgoal") &&
					goalClient
				) {
					handleGoCommand(
						resolved.entry.builtInName,
						resolved.args,
						goalClient,
						sessionId,
						onSystemMessage,
					);
					setValue("");
					return;
				}

				if (
					resolved &&
					resolved.entry.kind === "builtin" &&
					resolved.entry.builtInName &&
					onSlashCommand
				) {
					onSlashCommand(resolved.entry.builtInName, resolved.args);
					setValue("");
					return;
				}
			}

			// Regular command
			onSubmit(input);
			setValue("");
		},
		[
			onSubmit,
			onSlashCommand,
			allowEmptySubmit,
			slashRegistryEntries,
			slashByToken,
			goalClient,
			sessionId,
			onSystemMessage,
		],
	);

	// Get current step index
	const getCurrentStep = (): number => {
		switch (processingStage) {
			case "planning":
				return 0;
			case "toolshed":
				return 1;
			case "executing":
				return 2;
			case "complete":
				return 3;
			default:
				return 0;
		}
	};

	// Build processing status line (shown above input when agent is working)
	const processingStatusLine = isProcessing
		? (() => {
				const label = activeTool
					? `Running ${activeTool}`
					: stepCount === 0
						? "Thinking"
						: "Reasoning";

				const stats = [];
				if (stepCount > 0) stats.push(`step ${stepCount}`);
				if (toolCount > 0) stats.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
				if (totalTokens > 0) stats.push(`${(totalTokens / 1000).toFixed(1)}k tok`);

				return { label, stats };
			})()
		: null;

	return (
		<Box flexDirection="column" paddingX={1}>
			{/* Processing status — compact line above input, not replacing it */}
			{processingStatusLine && (
				<Box marginBottom={0}>
					<AnimatedSpinner
						type="dots"
						color={t.teal}
						label={processingStatusLine.label}
						showDots={true}
					/>
					{processingStatusLine.stats.length > 0 && (
						<MutedText> ({processingStatusLine.stats.join(" · ")})</MutedText>
					)}
				</Box>
			)}

			{/* Main input row — ALWAYS visible */}
			<Box>
				{/* Animated prompt */}
				<PromptIndicator pulse={promptPulse && showAnimations} />
				<Text> </Text>

				{/* Text input with ghost overlay */}
				<Box>
					<TextInput
						value={value}
						// TextInput owns its own key listener. Without this it keeps
						// typing into the chat line while the Ctrl+P palette (or any
						// other view) has focus, even when this box is display:none.
						focus={focused}
						// While a ghost suggestion shows, the cursor sits on the first
						// ghost character instead of a blank cell before it, so the
						// line reads "/settings" rather than "/sett ings".
						showCursor={!ghostVisible}
						onChange={(v) => {
							if (restoreRef.current !== null) {
								setValue(restoreRef.current);
								return;
							}
							// Any manual edit exits history navigation and updates the draft
							if (historyIndex !== -1) {
								setHistoryIndex(-1);
								draftRef.current = "";
							}
							setValue(transformInputValue ? transformInputValue(v) : v);
						}}
						onSubmit={handleSubmit}
						placeholder={
							isProcessing
								? "Queue a follow-up message..."
								: isVisible
									? ""
									: "Type a command or ask a question..."
						}
					/>

					{/* Ghost suggestion text; first char carries the cursor */}
					{ghostVisible && suggestion && (
						<>
							<AppText inverse>{suggestion.text.slice(0, 1)}</AppText>
							<MutedText>{suggestion.text.slice(1)}</MutedText>
						</>
					)}
				</Box>
			</Box>

			{/* Ghost suggestion hint */}
			{ghostVisible && suggestion && (
				<Box paddingLeft={2} overflow="hidden">
					<ShortcutHint
						keys="[Tab]"
						description={truncate(
							`to accept (${getSuggestionSourceLabel(suggestion.source)})`,
							Math.max(0, popupWidth - 10),
						)}
					/>
				</Box>
			)}

			{/* Slash command help */}
			{!isProcessing && showSlashHelp && (
				<SlashCommandHelp
					filter={value.trimStart().slice(1)}
					entries={slashRegistryEntries}
					width={popupWidth - 2}
					maxRows={popupRows}
				/>
			)}
		</Box>
	);
}

// ============================================
// /goal + /subgoal dispatch
// ============================================
//
// Lives in this file rather than app.tsx so the goal protocol stays
// localized to one place. The component handles parsing + dispatch, the
// daemon (via GoalClient transport) owns execution, and the surface
// messages (verdicts, help) are 8DO-owned copy imported through the
// goal-client barrel and the verdicts module.

function emitSystem(
	onSystemMessage: ((line: string) => void) | undefined,
	line: string,
): void {
	if (onSystemMessage) {
		onSystemMessage(line);
	}
}

export function handleGoCommand(
	commandName: "goal" | "subgoal",
	args: readonly string[],
	client: GoalClient,
	sessionId: string,
	onSystemMessage?: (line: string) => void,
): void {
	if (commandName === "subgoal") {
		const text = args.join(" ").trim();
		if (!text) {
			emitSystem(onSystemMessage, "/subgoal: text required. Try /subgoal <text>.");
			return;
		}
		try {
			client.subgoal(text);
			emitSystem(onSystemMessage, "Subgoal sent.");
		} catch (err) {
			emitSystem(
				onSystemMessage,
				`/subgoal: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return;
	}

	const parsed = parseGoCommand(args);
	switch (parsed.kind) {
		case "help": {
			emitSystem(onSystemMessage, GO_HELP_LINES.join("\n"));
			return;
		}
		case "invalid": {
			emitSystem(onSystemMessage, `/goal: ${parsed.reason}`);
			return;
		}
		case "start": {
			try {
				client.start(sessionId, parsed.goal);
				// Acknowledgement copy is intentionally minimal. The verdict
				// stream from LiveFocalStrip is the real surface.
				emitSystem(onSystemMessage, `Going. ${parsed.goal}`);
			} catch (err) {
				emitSystem(
					onSystemMessage,
					`/goal: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		case "status": {
			try {
				client.status();
			} catch (err) {
				emitSystem(
					onSystemMessage,
					`/goal status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		case "stop": {
			try {
				client.abort();
				emitSystem(onSystemMessage, "Stopping.");
			} catch (err) {
				emitSystem(
					onSystemMessage,
					`/goal stop: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		case "resume": {
			try {
				client.resume();
				emitSystem(onSystemMessage, "Resuming.");
			} catch (err) {
				emitSystem(
					onSystemMessage,
					`/goal resume: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		case "clear": {
			client.clear();
			emitSystem(onSystemMessage, "Cleared.");
			return;
		}
	}
}

// ============================================
// Sub-Components
// ============================================

// Animated prompt indicator
interface PromptIndicatorProps {
	pulse: boolean;
}

function PromptIndicator({ pulse }: PromptIndicatorProps) {
	const [colorIndex, setColorIndex] = useState(0);
	// Warm pulse (was cyan/blue/magenta — magenta violated the brand
	// prohibition on hues 270-350, and the whole cycle bled cool into
	// the always-on prompt). Now: orange brand pulse with a dim ember.
	const colors = [t.orange, t.orangeAlt, t.orangeDim, t.orange];

	useEffect(() => {
		const interval = setInterval(() => {
			setColorIndex((prev) => (prev + 1) % colors.length);
		}, 300);

		return () => clearInterval(interval);
	}, []);

	return (
		<Text color={colors[colorIndex] as any} bold>
			{"\u276F"}
		</Text>
	);
}

function getProcessingLabel(stage: string): string {
	switch (stage) {
		case "planning":
			return "Planning approach";
		case "toolshed":
			return "Querying toolshed";
		case "executing":
			return "Executing";
		case "complete":
			return "Finalizing";
		default:
			return "Processing";
	}
}

// Slash command help dropdown (built-ins + loaded skills)

/** Border (2) + paddingX (2) of the slash help box. */
const SLASH_BOX_CHROME_COLS = 4;
/** Widest the `/name` column grows; longer names are truncated. */
const SLASH_NAME_COL_MAX = 16;
/** Below this many columns the description is dropped rather than mangled. */
const SLASH_MIN_DESCRIPTION_COLS = 6;

/**
 * Column plan for a slash help box of `width` columns (border included).
 * Pure, so the row geometry is unit-testable without rendering.
 */
export function slashHelpColumns(
	width: number,
	names: string[],
): { inner: number; name: number; description: number } {
	const inner = Math.max(4, width - SLASH_BOX_CHROME_COLS);
	const longestName = names.reduce((max, n) => Math.max(max, n.length + 1), 0);
	const name = Math.min(SLASH_NAME_COL_MAX, longestName, inner);
	// One space between the name column and the description.
	const description = Math.max(0, inner - name - 1);
	return {
		inner,
		name,
		description: description < SLASH_MIN_DESCRIPTION_COLS ? 0 : description,
	};
}

function SlashCommandHelp({
	filter,
	entries,
	width,
	maxRows,
}: {
	filter: string;
	entries: SlashRegistryEntry[];
	/** Total box width, border included. */
	width: number;
	/** Maximum entries listed. */
	maxRows: number;
}) {
	const f = filter.toLowerCase();
	const filtered = entries.filter((entry) => entry.name.toLowerCase().startsWith(f));
	if (filtered.length === 0) return null;

	const shown = filtered.slice(0, Math.max(1, maxRows));
	const cols = slashHelpColumns(
		width,
		shown.map((entry) => entry.name),
	);
	const header =
		shown.length < filtered.length
			? `Commands (${shown.length} of ${filtered.length}):`
			: "Commands:";

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.teal}
			paddingX={1}
			width={width}
			flexShrink={0}
			overflow="hidden"
		>
			<MutedText>{truncate(header, cols.inner)}</MutedText>
			{shown.map((entry) => (
				<Box key={`${entry.kind}:${entry.token}`}>
					<AppText color={t.teal}>
						{padRight(truncate(`/${entry.name}`, cols.name), cols.name)}
					</AppText>
					{cols.description > 0 ? (
						<MutedText>{` ${truncate(entry.description, cols.description)}`}</MutedText>
					) : null}
				</Box>
			))}
		</Box>
	);
}

// ============================================
// Minimal Command Input
// ============================================

export function MinimalCommandInput({ onSubmit, isProcessing }: CommandInputProps) {
	const [value, setValue] = useState("");

	const handleSubmit = (input: string) => {
		if (!input.trim()) return;
		onSubmit(input);
		setValue("");
	};

	return (
		<Box paddingX={1}>
			{isProcessing ? (
				<Box>
					<AppText color="cyan">
						<Spinner type="dots" />
					</AppText>
					<MutedText> Working…</MutedText>
				</Box>
			) : (
				<Box>
					<Label color="cyan">$ </Label>
					<TextInput
						value={value}
						onChange={setValue}
						onSubmit={handleSubmit}
						placeholder="Enter command..."
					/>
				</Box>
			)}
		</Box>
	);
}

// ============================================
// Multi-line Command Input
// ============================================

interface MultiLineInputProps {
	onSubmit: (input: string) => void;
	isProcessing: boolean;
}

export function MultiLineInput({ onSubmit, isProcessing }: MultiLineInputProps) {
	const [lines, setLines] = useState<string[]>([""]);
	const [currentLine, setCurrentLine] = useState(0);

	// Not fully implemented - placeholder for future
	return (
		<Box flexDirection="column" paddingX={1}>
			<MutedText>Multi-line mode (Ctrl+Enter to submit)</MutedText>
			{/* Placeholder multi-line buffer (not fully implemented). Lines are positional rows of a draft and re-render-from-state on every change; no stable per-line identity exists in current schema. */}
			{lines.map((line, index) => (
				// react-doctor-disable-next-line react-doctor/no-array-index-as-key
				<Box key={index}>
					<MutedText>{index === currentLine ? "\u276F" : " "} </MutedText>
					<Text>{line}</Text>
				</Box>
			))}
		</Box>
	);
}

// ============================================
// Command Palette Style Input
// ============================================

interface CommandPaletteProps {
	onSubmit: (input: string) => void;
	suggestions?: string[];
}

export function CommandPalette({ onSubmit, suggestions = EMPTY_SUGGESTIONS }: CommandPaletteProps) {
	const [value, setValue] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	const filteredSuggestions = suggestions.filter((s) =>
		s.toLowerCase().includes(value.toLowerCase()),
	);

	useInput((input, key) => {
		if (key.downArrow) {
			setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
		} else if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		}
	});

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
				<Box>
					<Label color="cyan">{"\u276F"} </Label>
					<TextInput
						value={value}
						onChange={(v) => {
							setValue(v);
							setSelectedIndex(0);
						}}
						onSubmit={() => {
							const selected = filteredSuggestions[selectedIndex] || value;
							onSubmit(selected);
							setValue("");
						}}
					/>
				</Box>

				{value && filteredSuggestions.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						{filteredSuggestions.slice(0, 5).map((suggestion, index) => (
							<Box key={suggestion}>
								<Text
									color={index === selectedIndex ? "cyan" : "gray"}
									bold={index === selectedIndex}
								>
									{index === selectedIndex ? "\u25B8 " : "  "}
									{suggestion}
								</Text>
							</Box>
						))}
					</Box>
				)}
			</Box>
		</Box>
	);
}

// ============================================
// Ghost-Enhanced Command Input
// ============================================

interface GhostCommandInputProps {
	onSubmit: (input: string) => void;
	isProcessing: boolean;
	isGitRepo?: boolean;
	currentBranch?: string | null;
	planNextStep?: string | null;
	recentCommands?: string[];
	onSlashCommand?: (command: SlashCommand, args: string[]) => void;
}

function GhostCommandInput({
	onSubmit,
	isProcessing,
	isGitRepo = false,
	currentBranch = null,
	planNextStep = null,
	recentCommands = EMPTY_RECENT,
	onSlashCommand,
}: GhostCommandInputProps) {
	return (
		<CommandInput
			onSubmit={onSubmit}
			isProcessing={isProcessing}
			isGitRepo={isGitRepo}
			currentBranch={currentBranch}
			planNextStep={planNextStep}
			recentCommands={recentCommands}
			onSlashCommand={onSlashCommand}
		/>
	);
}

// ============================================
// Export Slash Commands for External Use
// ============================================

function getSlashCommands() {
	return getBuiltInSlashCommands();
}

function isSlashCommand(input: string): boolean {
	if (!input.startsWith("/")) return false;
	const cmdName = input.slice(1).split(/\s+/)[0].toLowerCase();
	return getBuiltInSlashCommands().some((c) => c.name === cmdName || c.aliases.includes(cmdName));
}

function parseSlashCommand(input: string): { command: SlashCommand; args: string[] } | null {
	if (!input.startsWith("/")) return null;

	const parts = input.slice(1).split(/\s+/);
	const cmdName = parts[0].toLowerCase();
	const args = parts.slice(1);

	const cmd = getBuiltInSlashCommands().find(
		(c) => c.name === cmdName || c.aliases.includes(cmdName),
	);

	if (!cmd) return null;

	return { command: cmd.name, args };
}
