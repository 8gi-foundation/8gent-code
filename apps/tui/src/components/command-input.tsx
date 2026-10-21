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

import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
	type ContextSuggestion,
	getSuggestionSourceLabel,
	useGhostSuggestion,
} from "../hooks/use-ghost-suggestion.js";
import { applyMention, listProjectFiles, mentionAtEnd, rankFiles } from "../lib/file-mention.js";
import { GO_HELP_LINES, type GoalClient, parseGoCommand } from "../lib/goal-client.js";
import { type SlashCommand, isCoreSlashCommand } from "../lib/slash-commands.js";
import {
	type SlashRegistryEntry,
	getBuiltInSlashCommands,
	getSlashRegistry,
	isBareSlash,
	resolveSlashInput,
	slashCollisionNotice,
	toGhostSuggestions,
	unknownSlashAnswer,
} from "../lib/slash-registry.js";
import { t } from "../theme.js";
import { AnimatedSpinner, StatusIndicator, StepIndicator } from "./animated-spinner.js";
import { BufferedTextInput } from "./buffered-text-input.js";
import { Blink } from "./fade-transition.js";
import { FigureEight } from "./figure-eight-spinner.js";
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
	/**
	 * Another surface has the keyboard (the DJ deck's keys, #3188): the text
	 * field takes no keys at all, so a deck key never types into the chat.
	 */
	typingPaused?: boolean;
	/** Rewrite the input on each change (e.g. consume a lone pasted file path into an attachment) */
	transformInputValue?: (value: string) => string;
	/** Show nothing of what is typed, only the placeholder (a key being pasted). */
	maskInput?: boolean;
	/** When true, Enter with an empty line still calls onSubmit (for empty send) */
	allowEmptySubmit?: boolean;
	/** An approval card is pending: the status line says the turn waits on the
	 *  person and stops spinning, and the placeholder points at the card (#3118). */
	approvalPending?: boolean;
	/** Project folder the `@` file list comes from. Defaults to process.cwd(). */
	cwd?: string;
	/** Told when the / menu opens or closes (a short terminal makes room for it). */
	onSlashMenuChange?: (open: boolean) => void;
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

// Module-level so remounts of the input (tab switches) do not repeat the line.
let collisionLineShown = false;

export function CommandInput({
	onSubmit,
	isProcessing,
	placeholder,
	maskInput = false,
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
	typingPaused = false,
	transformInputValue,
	allowEmptySubmit = false,
	approvalPending = false,
	cwd = process.cwd(),
	onSlashMenuChange,
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
				collisions: [],
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
				// Once per process: name any skill trigger that lost to a
				// builtin so the user learns why /voice is not their skill (#2932).
				const collisionLine = slashCollisionNotice(registry.collisions);
				if (collisionLine && !collisionLineShown) {
					collisionLineShown = true;
					onSystemMessage?.(collisionLine);
				}
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

	// `@` file mention (#3918 D2): the files matching the @token at the end
	// of the input. Each time a mention opens, the list reloads in the
	// background from the project folder (the old list shows meanwhile), so
	// new files appear and typing never waits on git.
	const mention = useMemo(() => mentionAtEnd(value), [value]);
	const mentionActive = mention !== null;
	const [projectFiles, setProjectFiles] = useState<{ cwd: string; files: string[] } | null>(null);
	const [mentionIndex, setMentionIndex] = useState(0);
	useEffect(() => {
		if (!mentionActive) return;
		let cancelled = false;
		void listProjectFiles(cwd).then((files) => {
			if (!cancelled) setProjectFiles({ cwd, files });
		});
		return () => {
			cancelled = true;
		};
	}, [mentionActive, cwd]);
	const mentionMatches = useMemo(
		() =>
			mention && projectFiles ? rankFiles(projectFiles.files, mention.query, MENTION_ROWS) : [],
		[mention, projectFiles],
	);
	useEffect(() => setMentionIndex(0), [mention?.query]);
	const mentionOpen = mention !== null && mentionMatches.length > 0;

	// Ghost suggestion hook
	const {
		suggestion,
		accept,
		dismiss,
		isVisible: ghostShown,
	} = useGhostSuggestion(value, {
		isGitRepo,
		currentBranch,
		planNextStep,
		recentCommands,
		extraContextSuggestions: extraSlashContext,
	});
	// Never offer a shell line: Tab would complete a command nobody typed
	// (#3918 D5, 8SO).
	const isVisible = !maskInput && ghostShown && !isShellSuggestion(value, suggestion?.text);

	// Slash palette: show while typing the command token (no space yet) so long names like /billiondollarboardroom work
	useEffect(() => {
		const t = value.trimStart();
		setShowSlashHelp(t.startsWith("/") && !t.slice(1).includes(" "));
	}, [value]);

	// The menu's rows, how many fit this terminal, and the picked one.
	// Up/Down scroll through every row; Tab puts the picked command in.
	const { stdout } = useStdout();
	const terminalRows = stdout?.rows ?? 24;
	const slashVisible = slashMenuVisibleRows(terminalRows);
	const slashFilter = value.trimStart().slice(1);
	const slashRows = useMemo(
		() => (showSlashHelp ? slashMenuRows(slashFilter, slashRegistryEntries) : []),
		[showSlashHelp, slashFilter, slashRegistryEntries],
	);
	const [slashIndex, setSlashIndex] = useState(0);
	useEffect(() => setSlashIndex(0), [slashFilter]);
	const slashOpen = !isProcessing && showSlashHelp && slashRows.length > 0;
	useEffect(() => onSlashMenuChange?.(slashOpen), [slashOpen, onSlashMenuChange]);

	// Handle keyboard input
	useInput(
		(input, key) => {
			// An open @ file list takes Tab, Up and Down before anything else.
			if (mentionOpen && mention) {
				if (key.tab && !key.shift) {
					const file = mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)];
					if (file) setValue(applyMention(value, mention.start, file));
					return;
				}
				if (key.upArrow) {
					setMentionIndex((i) => Math.max(0, i - 1));
					return;
				}
				if (key.downArrow) {
					setMentionIndex((i) => Math.min(mentionMatches.length - 1, i + 1));
					return;
				}
			}

			// An open / menu takes Up, Down and Tab.
			if (slashOpen) {
				if (key.upArrow) {
					setSlashIndex((i) => Math.max(0, i - 1));
					return;
				}
				if (key.downArrow) {
					setSlashIndex((i) => Math.min(slashRows.length - 1, i + 1));
					return;
				}
				if (key.tab && !key.shift) {
					const row = slashRows[Math.min(slashIndex, slashRows.length - 1)];
					if (row) setValue(`/${row.name} `);
					return;
				}
			}

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
				const nextIndex =
					historyIndex < recentCommands.length - 1 ? historyIndex + 1 : historyIndex;
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

	const submitNow = useCallback(
		(input: string) => {
			const trimmed = input.trim();
			if (!trimmed && !allowEmptySubmit) return;

			// Reset history navigation on submit
			setHistoryIndex(-1);
			draftRef.current = "";

			// Check for slash command
			if (trimmed.startsWith("/")) {
				const registry = {
					entries: slashRegistryEntries,
					byToken: slashByToken,
					collisions: [],
				};
				const resolved = resolveSlashInput(input, registry);

				// /goal and /subgoal: handled in-component when a GoalClient is
				// wired in. Falls through to onSlashCommand otherwise so the
				// app can render a clean "goal loop not connected" message.
				if (
					resolved?.entry.kind === "builtin" &&
					(resolved.entry.builtInName === "goal" || resolved.entry.builtInName === "subgoal") &&
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

	// Nothing goes straight to the model (#4530): a slash line the registry does
	// not know is checked against skills and prompt templates read now, and only
	// when nothing claims it is it answered here and never submitted.
	const handleSubmit = useCallback(
		(input: string) => {
			// A key being pasted is an answer, never a slash line or a command.
			if (maskInput) return submitNow(input);
			const trimmed = input.trim();
			// A bare "/" opens the same thing /help does, never an error.
			if (isBareSlash(input)) return submitNow("/help");
			if (!trimmed.startsWith("/")) return submitNow(input);
			const registry = { entries: slashRegistryEntries, byToken: slashByToken, collisions: [] };
			if (resolveSlashInput(input, registry)) return submitNow(input);
			setValue("");
			void unknownSlashAnswer(input, registry).then((unknown) => {
				if (unknown === null) return submitNow(input);
				emitSystem(onSystemMessage, unknown);
			});
		},
		[submitNow, slashRegistryEntries, slashByToken, onSystemMessage, maskInput],
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
			) : (
				processingStatusLine && (
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
				)
			)}

			{/* Main input row — ALWAYS visible */}
			<Box>
				{/* Animated prompt */}
				<PromptIndicator />
				<Text> </Text>

				{/* Text input with ghost overlay */}
				<Box>
					<BufferedTextInput
						focus={!typingPaused}
						mask={maskInput}
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

			{/* @ file mention list */}
			{!isProcessing && mentionOpen && (
				<FileMentionList files={mentionMatches} selected={mentionIndex} />
			)}

			{/* Slash command help */}
			{!isProcessing && showSlashHelp && (
				<SlashCommandHelp
					rows={slashRows}
					selected={slashIndex}
					visible={slashVisible}
					compact={slashMenuCompact(terminalRows)}
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

function emitSystem(onSystemMessage: ((line: string) => void) | undefined, line: string): void {
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
			emitSystem(onSystemMessage, `/subgoal: ${err instanceof Error ? err.message : String(err)}`);
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
				emitSystem(onSystemMessage, `/goal: ${err instanceof Error ? err.message : String(err)}`);
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

function isCoreEntry(entry: SlashRegistryEntry): boolean {
	return (
		entry.kind === "builtin" &&
		entry.builtInName !== undefined &&
		entry.name === entry.canonicalName &&
		isCoreSlashCommand(entry.builtInName)
	);
}

/**
 * Rows for the `/` menu. A bare `/` lists the core commands only; once a
 * letter is typed every command and skill whose name starts with it shows,
 * core commands first. Nothing is removed: a hidden command still runs when
 * typed (#3918, Pi gap D9).
 */
export function slashMenuRows(filter: string, entries: SlashRegistryEntry[]): SlashRegistryEntry[] {
	const f = filter.toLowerCase();
	if (f === "") {
		return entries.filter(isCoreEntry).toSorted((a, b) => a.name.localeCompare(b.name));
	}
	const matches = entries.filter((entry) => entry.name.toLowerCase().startsWith(f));
	return [...matches.filter(isCoreEntry), ...matches.filter((e) => !isCoreEntry(e))];
}

export const SLASH_MENU_ROWS = 14;
/** Below this many terminal rows the menu drops its frame and the focal strip steps aside. */
export const SLASH_MENU_COMPACT_BELOW = 30;
/**
 * Terminal rows the TUI keeps around the menu, measured in the real App
 * (slash-menu-height.test.tsx). Framed: header, tabs, frame, focal strip,
 * input, footer, and the menu's margin, border, title and position line.
 * Compact: the same without the focal strip, margin, border and title. The
 * App's frame is itself two rows shorter than the terminal.
 */
export const SLASH_MENU_CHROME = { framed: 18, compact: 11 } as const;

export function slashMenuCompact(terminalRows: number): boolean {
	return terminalRows < SLASH_MENU_COMPACT_BELOW;
}

/** Menu rows that fit a terminal `terminalRows` tall: min(14, rows - chrome), at least 1. */
export function slashMenuVisibleRows(terminalRows: number): number {
	const chrome = slashMenuCompact(terminalRows)
		? SLASH_MENU_CHROME.compact
		: SLASH_MENU_CHROME.framed;
	return Math.max(1, Math.min(SLASH_MENU_ROWS, terminalRows - chrome));
}

/** The window of `total` rows, `visible` tall, that keeps `selected` in view. */
export function slashMenuWindow(
	total: number,
	selected: number,
	visible: number,
): { start: number; end: number } {
	if (total <= visible) return { start: 0, end: total };
	const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
	return { start, end: start + visible };
}

// Slash command help dropdown (built-ins + loaded skills)
export function SlashCommandHelp({
	rows,
	selected,
	visible,
	compact = false,
}: {
	rows: SlashRegistryEntry[];
	selected: number;
	visible: number;
	compact?: boolean;
}) {
	if (rows.length === 0) return null;
	const { start, end } = slashMenuWindow(rows.length, selected, visible);
	const combined = rows.slice(start, end).map((entry, i) => ({
		key: `${entry.kind}:${entry.token}`,
		label: entry.name,
		description: entry.description,
		picked: start + i === selected,
	}));

	return (
		<Box
			flexDirection="column"
			borderStyle={compact ? undefined : "round"}
			borderColor={t.frame}
			paddingX={1}
			marginTop={compact ? 0 : 1}
			flexShrink={0}
		>
			{!compact && (
				<Text color={t.heading} bold>
					COMMANDS
				</Text>
			)}
			{combined.map((row) => (
				// One line per row, cut at the edge: a wrapped row would push the
				// menu past the rows the terminal has.
				<Text key={row.key} wrap="truncate-end">
					<Text color={row.picked ? t.heading : t.textPrimary}>
						{row.picked ? "> " : "  "}/{row.label}
					</Text>
					<Text color={t.textTertiary}> {row.description}</Text>
				</Text>
			))}
			{rows.length > end - start && (
				<Text color={t.textTertiary}>
					{`${start + 1}-${end} of ${rows.length}, Up/Down to scroll, Tab to pick`}
				</Text>
			)}
		</Box>
	);
}

const MENTION_ROWS = 8;

// The @ file list: matching files, the picked one marked, Tab to insert.
function FileMentionList({ files, selected }: { files: string[]; selected: number }) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={t.frame}
			paddingX={1}
			marginTop={1}
		>
			<Text color={t.heading} bold>
				FILES <Text color={t.textTertiary}>Up/Down to pick, Tab to insert</Text>
			</Text>
			{files.map((file, i) => (
				<Text key={file} color={i === selected ? t.textPrimary : t.textTertiary}>
					{i === selected ? "> " : "  "}
					{file}
				</Text>
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

/** True when accepting the ghost text would leave a `!` shell line in the input. */
export function isShellSuggestion(value: string, ghost: string | undefined): boolean {
	return `${value}${ghost ?? ""}`.trimStart().startsWith("!");
}
