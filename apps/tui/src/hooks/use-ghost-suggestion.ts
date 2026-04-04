/**
 * 8gent Code - Ghost Suggestion Hook
 *
 * Manages ghost text suggestions that appear after the cursor.
 * Sources:
 * - Next step in the current PLAN
 * - Recent command history
 * - Context-aware predictions (git commands in git repo, etc.)
 */

import { useCallback, useEffect, useMemo, useState } from "react";

// ============================================
// Types
// ============================================

export interface GhostSuggestion {
	text: string;
	source: SuggestionSource;
	confidence: number;
	metadata?: Record<string, unknown>;
}

export type SuggestionSource =
	| "plan" // From current plan's next step
	| "history" // From command history
	| "context" // Context-aware (git, npm, etc.)
	| "ai"; // AI-generated prediction

export interface ContextSuggestion {
	trigger: string;
	suggestion: string;
	confidence: number;
}

export interface GhostSuggestionOptions {
	maxHistoryItems?: number;
	debounceMs?: number;
	isGitRepo?: boolean;
	currentBranch?: string | null;
	planNextStep?: string | null;
	recentCommands?: string[];
	/** Merged after built-in context suggestions; longer triggers sort first for better slash matching */
	extraContextSuggestions?: ContextSuggestion[];
}

// ============================================
// Hook
// ============================================

export function useGhostSuggestion(
	currentInput: string,
	options: GhostSuggestionOptions = {},
): {
	suggestion: GhostSuggestion | null;
	accept: () => string;
	dismiss: () => void;
	isVisible: boolean;
} {
	const {
		maxHistoryItems = 20,
		debounceMs = 150,
		isGitRepo = false,
		currentBranch = null,
		planNextStep = null,
		recentCommands = [],
		extraContextSuggestions = [],
	} = options;

	const [suggestion, setSuggestion] = useState<GhostSuggestion | null>(null);
	const [isVisible, setIsVisible] = useState(false);

	// Memoize command history patterns
	const historyPatterns = useMemo(() => {
		return buildHistoryPatterns(recentCommands, maxHistoryItems);
	}, [recentCommands, maxHistoryItems]);

	// Context-aware suggestions
	const contextSuggestions = useMemo(() => {
		const merged = [
			...buildContextSuggestions(isGitRepo, currentBranch),
			...extraContextSuggestions,
		];
		merged.sort((a, b) => b.trigger.length - a.trigger.length);
		return merged;
	}, [isGitRepo, currentBranch, extraContextSuggestions]);

	// Generate suggestion based on current input
	useEffect(() => {
		if (!currentInput.trim()) {
			setSuggestion(null);
			setIsVisible(false);
			return;
		}

		const timeoutId = setTimeout(() => {
			const newSuggestion = findBestSuggestion(
				currentInput,
				planNextStep,
				historyPatterns,
				contextSuggestions,
			);

			setSuggestion(newSuggestion);
			setIsVisible(!!newSuggestion);
		}, debounceMs);

		return () => clearTimeout(timeoutId);
	}, [
		currentInput,
		planNextStep,
		historyPatterns,
		contextSuggestions,
		debounceMs,
	]);

	// Accept the current suggestion
	const accept = useCallback((): string => {
		if (!suggestion) return currentInput;
		const fullText = currentInput + suggestion.text;
		setSuggestion(null);
		setIsVisible(false);
		return fullText;
	}, [currentInput, suggestion]);

	// Dismiss the current suggestion
	const dismiss = useCallback(() => {
		setSuggestion(null);
		setIsVisible(false);
	}, []);

	return {
		suggestion,
		accept,
		dismiss,
		isVisible,
	};
}

// ============================================
// Suggestion Generation
// ============================================

interface HistoryPattern {
	prefix: string;
	completion: string;
	frequency: number;
}

function buildHistoryPatterns(
	commands: string[],
	maxItems: number,
): HistoryPattern[] {
	const patterns: Map<string, { completion: string; frequency: number }> =
		new Map();

	for (const cmd of commands.slice(0, maxItems)) {
		// Build prefix patterns from each command
		const words = cmd.split(/\s+/);
		for (let i = 1; i <= words.length; i++) {
			const prefix = words.slice(0, i).join(" ");
			const completion = words.slice(i).join(" ");

			if (completion) {
				const existing = patterns.get(prefix);
				if (existing) {
					existing.frequency += 1;
				} else {
					patterns.set(prefix, { completion, frequency: 1 });
				}
			}
		}
	}

	return Array.from(patterns.entries())
		.map(([prefix, { completion, frequency }]) => ({
			prefix,
			completion,
			frequency,
		}))
		.sort((a, b) => b.frequency - a.frequency);
}

export function buildContextSuggestions(
	isGitRepo: boolean,
	currentBranch: string | null,
): ContextSuggestion[] {
	const suggestions: ContextSuggestion[] = [];

	// Common commands
	suggestions.push(
		{ trigger: "npm", suggestion: " run dev", confidence: 0.6 },
		{ trigger: "npm i", suggestion: "nstall", confidence: 0.8 },
		{ trigger: "npm run", suggestion: " dev", confidence: 0.7 },
		{ trigger: "npm test", suggestion: "", confidence: 0.9 },
		{ trigger: "bun", suggestion: " run dev", confidence: 0.6 },
		{ trigger: "bun run", suggestion: " dev", confidence: 0.7 },
	);

	// Git commands
	if (isGitRepo) {
		suggestions.push(
			{ trigger: "git", suggestion: " status", confidence: 0.7 },
			{ trigger: "git s", suggestion: "tatus", confidence: 0.9 },
			{ trigger: "git st", suggestion: "atus", confidence: 0.95 },
			{ trigger: "git a", suggestion: "dd -A", confidence: 0.7 },
			{ trigger: "git ad", suggestion: "d -A", confidence: 0.8 },
			{ trigger: "git add", suggestion: " -A", confidence: 0.8 },
			{ trigger: "git c", suggestion: "ommit -m ", confidence: 0.7 },
			{ trigger: "git co", suggestion: "mmit -m ", confidence: 0.8 },
			{ trigger: "git com", suggestion: "mit -m ", confidence: 0.9 },
			{ trigger: "git commit", suggestion: " -m ", confidence: 0.9 },
			{ trigger: "git p", suggestion: "ush", confidence: 0.7 },
			{ trigger: "git pu", suggestion: "sh", confidence: 0.8 },
			{ trigger: "git push", suggestion: "", confidence: 0.9 },
			{ trigger: "git pull", suggestion: "", confidence: 0.9 },
			{ trigger: "git ch", suggestion: "eckout", confidence: 0.8 },
			{ trigger: "git checkout", suggestion: " -b", confidence: 0.6 },
			{ trigger: "git d", suggestion: "iff", confidence: 0.7 },
			{ trigger: "git di", suggestion: "ff", confidence: 0.8 },
			{ trigger: "git diff", suggestion: "", confidence: 0.9 },
			{ trigger: "git l", suggestion: "og --oneline", confidence: 0.6 },
			{ trigger: "git log", suggestion: " --oneline", confidence: 0.7 },
			{ trigger: "git b", suggestion: "ranch", confidence: 0.7 },
			{ trigger: "git br", suggestion: "anch", confidence: 0.8 },
		);

		// Branch-specific suggestions
		if (
			currentBranch &&
			currentBranch !== "main" &&
			currentBranch !== "master"
		) {
			suggestions.push({
				trigger: "git push",
				suggestion: ` origin ${currentBranch}`,
				confidence: 0.8,
			});
		}
	}

	// Slash commands for 8gent
	suggestions.push(
		{ trigger: "/h", suggestion: "elp", confidence: 0.9 },
		{ trigger: "/he", suggestion: "lp", confidence: 0.95 },
		{ trigger: "/p", suggestion: "lan", confidence: 0.7 },
		{ trigger: "/pl", suggestion: "an", confidence: 0.85 },
		{ trigger: "/k", suggestion: "anban", confidence: 0.8 },
		{ trigger: "/ka", suggestion: "nban", confidence: 0.9 },
		{ trigger: "/kan", suggestion: "ban", confidence: 0.95 },
		{ trigger: "/pr", suggestion: "edict", confidence: 0.8 },
		{ trigger: "/pre", suggestion: "dict", confidence: 0.9 },
		{ trigger: "/av", suggestion: "enues", confidence: 0.8 },
		{ trigger: "/ave", suggestion: "nues", confidence: 0.9 },
		{ trigger: "/c", suggestion: "lear", confidence: 0.7 },
		{ trigger: "/cl", suggestion: "ear", confidence: 0.85 },
		{ trigger: "/q", suggestion: "uit", confidence: 0.8 },
		{ trigger: "/qu", suggestion: "it", confidence: 0.9 },
	);

	return suggestions;
}

// Empty state suggestions when no input
const EMPTY_STATE_SUGGESTIONS = [
	"build a landing page",
	"fix the bug in...",
	"add a new feature to...",
	"refactor the authentication",
	"create a REST API",
	"help me understand this codebase",
	"add tests for...",
	"what can you do?",
	"/help",
	"scaffold a new project",
];

function getEmptyStateSuggestion(
	planNextStep: string | null,
	isGitRepo: boolean,
): GhostSuggestion | null {
	// If there's a plan step, suggest that first
	if (planNextStep) {
		return {
			text: planNextStep,
			source: "plan",
			confidence: 0.9,
			metadata: { emptyState: true },
		};
	}

	// Git-specific suggestions
	if (isGitRepo) {
		const gitSuggestions = [
			"git status",
			"show me recent changes",
			"commit my changes",
			"create a new branch",
		];
		const suggestion =
			gitSuggestions[Math.floor(Math.random() * gitSuggestions.length)];
		return {
			text: suggestion,
			source: "context",
			confidence: 0.5,
			metadata: { emptyState: true },
		};
	}

	// Random general suggestion
	const suggestion =
		EMPTY_STATE_SUGGESTIONS[
			Math.floor(Math.random() * EMPTY_STATE_SUGGESTIONS.length)
		];
	return {
		text: suggestion,
		source: "context",
		confidence: 0.4,
		metadata: { emptyState: true },
	};
}

function findBestSuggestion(
	input: string,
	planNextStep: string | null,
	historyPatterns: HistoryPattern[],
	contextSuggestions: ContextSuggestion[],
): GhostSuggestion | null {
	const inputLower = input.toLowerCase().trim();

	// 1. Check if plan next step matches
	if (planNextStep && planNextStep.toLowerCase().startsWith(inputLower)) {
		const completion = planNextStep.slice(input.length);
		if (completion) {
			return {
				text: completion,
				source: "plan",
				confidence: 0.9,
				metadata: { fullText: planNextStep },
			};
		}
	}

	// 2. Check context suggestions
	for (const ctx of contextSuggestions) {
		if (inputLower === ctx.trigger.toLowerCase()) {
			return {
				text: ctx.suggestion,
				source: "context",
				confidence: ctx.confidence,
			};
		}
		if (
			ctx.trigger.toLowerCase().startsWith(inputLower) &&
			inputLower.length >= 2
		) {
			const completion = ctx.trigger.slice(input.length) + ctx.suggestion;
			return {
				text: completion,
				source: "context",
				confidence: ctx.confidence * 0.8,
			};
		}
	}

	// 3. Check history patterns
	for (const pattern of historyPatterns) {
		if (pattern.prefix.toLowerCase().startsWith(inputLower)) {
			const completion =
				pattern.prefix.slice(input.length) + " " + pattern.completion;
			return {
				text: completion,
				source: "history",
				confidence: Math.min(0.8, 0.3 + pattern.frequency * 0.1),
				metadata: { frequency: pattern.frequency },
			};
		}
	}

	return null;
}

// ============================================
// Utility Exports
// ============================================

export function formatGhostText(suggestion: GhostSuggestion | null): string {
	return suggestion?.text || "";
}

export function getSuggestionSourceLabel(source: SuggestionSource): string {
	switch (source) {
		case "plan":
			return "from plan";
		case "history":
			return "from history";
		case "context":
			return "suggested";
		case "ai":
			return "predicted";
		default:
			return "";
	}
}
