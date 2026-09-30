/**
 * 8gent Code - Animated Command Input Component
 *
 * Features:
 * - Animated spinner with status text
 * - A still prompt chevron (an idle prompt never redraws the screen)
 * - Step indicator for multi-step operations
 * - Ghost text suggestions (Tab to accept)
 * - Slash command support (/kanban, /predict, /avenues)
 */

import { Box, Text, useInput } from "ink";
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
import { t } from "../theme.js";
import { AnimatedSpinner, StatusIndicator, StepIndicator } from "./animated-spinner.js";
import { FigureEight } from "./figure-eight-spinner.js";
import { Blink } from "./fade-transition.js";
import { BufferedTextInput } from "./buffered-text-input.js";
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
	/** Idle placeholder override: what a waiting question expects ("Your name"). */
	placeholder?: string;
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
	/** An approval card is pending: the status line says the turn waits on the
	 *  person and stops spinning, and the placeholder points at the card (#3118). */
	approvalPending?: boolean;
}

/** The status line while an approval card waits on the person (#3118). */
export const WAITING_LINE = "Waiting for you. Nothing runs until you answer.";
/** The input placeholder then: the card owns Y, N, E and S. */
export const WAITING_PLACEHOLDER = "Answer the card above first";

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

/**
 * Ink emits one input event per stdin read. When the event loop is busy
 * (a heavy TUI re-render) the typed text and the Enter byte land in the
 * same read, e.g. "hello\r". Ink only flags an event as Enter when it is
 * exactly "\r", so the text input inserts the CR into the value and the
 * message is not sent until a second Enter. A value that now ends in a
 * line break therefore means the user pressed Enter: strip the break and
 * submit. Line breaks inside the value (a multi-line paste with no
 * trailing newline) are left alone.
 */
export function splitTrailingEnter(value: string): { text: string; submit: boolean } {
	const trailing = /[\r\n]+$/;
	if (!trailing.test(value)) return { text: value, submit: false };
	return { text: value.replace(trailing, ""), submit: true };
}

// ============================================
// Main Command Input
// ============================================

export function CommandInput({
	onSubmit,
	isProcessing,
	placeholder,
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
	approvalPending = false,
// Multiple useState calls model independent slices with different update sources; a reducer would conflate orthogonal events.
// react-doctor-disable-next-line react-doctor/prefer-useReducer
}: CommandInputProps) {
	const [value, setValue] = useState("");
	// History navigation: -1 = at draft (bottom), 0..N-1 = index into recentCommands
	const [historyIndex, setHistoryIndex] = useState(-1);
	const draftRef = useRef("");
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

	// Slash palette: show while typing the command token (no space yet) so long names like /billiondollarboardroom work
	useEffect(() => {
		const t = value.trimStart();
		setShowSlashHelp(t.startsWith("/") && !t.slice(1).includes(" "));
	}, [value]);

	// Handle keyboard input
	useInput(
		(input, key) => {
			// Tab to accept ghost suggestion. Not Shift+Tab: Ink sets key.tab for
			// it too, and Shift+Tab switches the permission mode (#3170).
			if (key.tab && !key.shift && isVisible && suggestion) {
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
		{ isActive: !isProcessing && focused },
	);

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
			{approvalPending ? (
				<Box marginBottom={0}>
					<Text color={t.orange}>{WAITING_LINE}</Text>
				</Box>
			) : processingStatusLine && (
				<Box marginBottom={0}>
					<AnimatedSpinner
						color={t.teal}
						label={processingStatusLine.label}
						showDots={showAnimations}
						animate={showAnimations}
					/>
					{processingStatusLine.stats.length > 0 && (
						<MutedText> ({processingStatusLine.stats.join(" · ")})</MutedText>
					)}
				</Box>
			)}

			{/* Main input row — ALWAYS visible */}
			<Box>
				{/* Animated prompt */}
				<PromptIndicator />
				<Text> </Text>

				{/* Text input with ghost overlay */}
				<Box>
					<BufferedTextInput
						value={value}
						onChange={(v) => {
							// Any manual edit exits history navigation and updates the draft
							if (historyIndex !== -1) {
								setHistoryIndex(-1);
								draftRef.current = "";
							}
							const { text, submit } = splitTrailingEnter(v);
							const next = transformInputValue ? transformInputValue(text) : text;
							setValue(next);
							// Enter arrived in the same stdin read as the text, so it
							// reached the input as text, not as a return key.
							if (submit) handleSubmit(next);
						}}
						onSubmit={handleSubmit}
						placeholder={
							approvalPending
								? WAITING_PLACEHOLDER
								: isProcessing
									? "Queue a follow-up message..."
									: isVisible
									? ""
									: (placeholder ?? "Type a command or ask a question...")
						}
					/>

					{/* Ghost suggestion text */}
					{!isProcessing && isVisible && suggestion && <MutedText>{suggestion.text}</MutedText>}
				</Box>
			</Box>

			{/* Ghost suggestion hint */}
			{!isProcessing && isVisible && suggestion && (
				<Box paddingLeft={2}>
					<ShortcutHint
						keys="[Tab]"
						description={`to accept (${getSuggestionSourceLabel(suggestion.source)})`}
					/>
				</Box>
			)}

			{/* Slash command help */}
			{!isProcessing && showSlashHelp && (
				<SlashCommandHelp filter={value.trimStart().slice(1)} entries={slashRegistryEntries} />
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

// Prompt chevron. It holds still: the HUD motion language (lib/motion.ts)
// says nothing loops, and every React commit makes Ink lay out and rewrite
// the whole screen. The old 300 ms colour cycle (plus an 800 ms pulse
// toggle that changed nothing on screen) was 4.6 full-screen redraws a
// second on an idle TUI, most of its idle CPU.
function PromptIndicator() {
	return (
		<Text color={t.orange as any} bold>
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
function SlashCommandHelp({
	filter,
	entries,
}: {
	filter: string;
	entries: SlashRegistryEntry[];
}) {
	const f = filter.toLowerCase();
	const filtered = entries.filter((entry) => entry.name.toLowerCase().startsWith(f));

	const combined = filtered.map((entry) => ({
		key: `${entry.kind}:${entry.token}`,
		label: entry.name,
		description: entry.description,
	}));

	if (combined.length === 0) return null;

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
			<MutedText>Commands:</MutedText>
			{combined.slice(0, 14).map((row) => (
				<Box key={row.key}>
					<AppText color="cyan">/{row.label}</AppText>
					<MutedText> - {row.description}</MutedText>
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
						<FigureEight />
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
