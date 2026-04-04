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
import React, {
	useState,
	useEffect,
	useCallback,
	useRef,
	useMemo,
} from "react";
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
	AnimatedSpinner,
	StatusIndicator,
	StepIndicator,
} from "./animated-spinner.js";
import { Blink } from "./fade-transition.js";
import {
	AppText,
	Inline,
	Label,
	MutedText,
	ShortcutHint,
} from "./primitives/index.js";
import { WaveProgress } from "./progress-bar.js";

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
	/** Text injected from voice transcription — appended to current input for review */
	injectedText?: string | null;
	/** Whether the input is focused (false when non-chat views are active) */
	focused?: boolean;
	/** Rewrite the input on each change (e.g. consume a lone pasted file path into an attachment) */
	transformInputValue?: (value: string) => string;
	/** When true, Enter with an empty line still calls onSubmit (for empty send) */
	allowEmptySubmit?: boolean;
}

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
	recentCommands = [],
	onSlashCommand,
	injectedText = null,
	focused = true,
	transformInputValue,
	allowEmptySubmit = false,
}: CommandInputProps) {
	const [value, setValue] = useState("");
	const [promptPulse, setPromptPulse] = useState(true);
	const [showSlashHelp, setShowSlashHelp] = useState(false);
	const [slashRegistryEntries, setSlashRegistryEntries] = useState<
		SlashRegistryEntry[]
	>([]);
	const [slashByToken, setSlashByToken] = useState<
		Map<string, SlashRegistryEntry>
	>(new Map());

	const builtInSlashGhosts = useMemo(
		() => buildBuiltInSlashGhostSuggestions(),
		[],
	);
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
			setValue((prev) => (prev ? prev + " " + injectedText : injectedText));
		}
	}, [injectedText]);

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
		},
		{ isActive: !isProcessing && focused },
	);

	const handleSubmit = useCallback(
		(input: string) => {
			const trimmed = input.trim();
			if (!trimmed && !allowEmptySubmit) return;

			// Check for slash command
			if (trimmed.startsWith("/")) {
				const resolved = resolveSlashInput(input, {
					entries: slashRegistryEntries,
					byToken: slashByToken,
				});
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
				if (toolCount > 0)
					stats.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
				if (totalTokens > 0)
					stats.push(`${(totalTokens / 1000).toFixed(1)}k tok`);

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
						color="cyan"
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
						onChange={(v) =>
							setValue(transformInputValue ? transformInputValue(v) : v)
						}
						onSubmit={handleSubmit}
						placeholder={
							isProcessing
								? "Queue a follow-up message..."
								: isVisible
									? ""
									: "Type a command or ask a question..."
						}
					/>

					{/* Ghost suggestion text */}
					{!isProcessing && isVisible && suggestion && (
						<MutedText>{suggestion.text}</MutedText>
					)}
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
				<SlashCommandHelp
					filter={value.trimStart().slice(1)}
					entries={slashRegistryEntries}
				/>
			)}
		</Box>
	);
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
	const colors = ["cyan", "blue", "magenta", "cyan"];

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
function SlashCommandHelp({
	filter,
	entries,
}: {
	filter: string;
	entries: SlashRegistryEntry[];
}) {
	const f = filter.toLowerCase();
	const filtered = entries.filter((entry) =>
		entry.name.toLowerCase().startsWith(f),
	);

	const combined = filtered.map((entry) => ({
		key: `${entry.kind}:${entry.token}`,
		label: entry.name,
		description: entry.description,
	}));

	if (combined.length === 0) return null;

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="blue"
			paddingX={1}
			marginTop={1}
		>
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

export function MinimalCommandInput({
	onSubmit,
	isProcessing,
}: CommandInputProps) {
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
					<MutedText> Working...</MutedText>
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

export function MultiLineInput({
	onSubmit,
	isProcessing,
}: MultiLineInputProps) {
	const [lines, setLines] = useState<string[]>([""]);
	const [currentLine, setCurrentLine] = useState(0);

	// Not fully implemented - placeholder for future
	return (
		<Box flexDirection="column" paddingX={1}>
			<MutedText>Multi-line mode (Ctrl+Enter to submit)</MutedText>
			{lines.map((line, index) => (
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

export function CommandPalette({
	onSubmit,
	suggestions = [],
}: CommandPaletteProps) {
	const [value, setValue] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	const filteredSuggestions = suggestions.filter((s) =>
		s.toLowerCase().includes(value.toLowerCase()),
	);

	useInput((input, key) => {
		if (key.downArrow) {
			setSelectedIndex((prev) =>
				Math.min(prev + 1, filteredSuggestions.length - 1),
			);
		} else if (key.upArrow) {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		}
	});

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box
				borderStyle="round"
				borderColor="cyan"
				paddingX={1}
				flexDirection="column"
			>
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

export interface GhostCommandInputProps {
	onSubmit: (input: string) => void;
	isProcessing: boolean;
	isGitRepo?: boolean;
	currentBranch?: string | null;
	planNextStep?: string | null;
	recentCommands?: string[];
	onSlashCommand?: (command: SlashCommand, args: string[]) => void;
}

export function GhostCommandInput({
	onSubmit,
	isProcessing,
	isGitRepo = false,
	currentBranch = null,
	planNextStep = null,
	recentCommands = [],
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

export function getSlashCommands() {
	return getBuiltInSlashCommands();
}

export function isSlashCommand(input: string): boolean {
	if (!input.startsWith("/")) return false;
	const cmdName = input.slice(1).split(/\s+/)[0].toLowerCase();
	return getBuiltInSlashCommands().some(
		(c) => c.name === cmdName || c.aliases.includes(cmdName),
	);
}

export function parseSlashCommand(
	input: string,
): { command: SlashCommand; args: string[] } | null {
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
