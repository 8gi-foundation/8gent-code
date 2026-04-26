/**
 * 8gent Code - Design Agent
 *
 * Proactively suggests design systems before implementation begins.
 * Integrates with the planning phase to intervene when UI/frontend
 * tasks are detected.
 *
 * Flow:
 * 1. User gives task like "create a landing page"
 * 2. Detector identifies design decision needed
 * 3. Agent intervenes BEFORE implementation
 * 4. Presents 2-3 design system options
 * 5. User chooses (or agent picks default)
 * 6. Implementation proceeds with chosen design system
 *
 * Integration points:
 * - Planning phase (packages/planning/)
 * - Avenue exploration (ProactivePlanner)
 * - TUI (apps/tui/src/components/)
 * - /design slash command
 */

import { EventEmitter } from "events";
import {
	type DesignCategory,
	DesignDecisionDetector,
	type DetectionResult,
	type DetectorConfig,
	createDetector,
	detectDesignNeed,
	needsDesignDecision,
} from "./detector.js";
import {
	FOLLOW_UP_PROMPTS,
	type ProjectType,
	QUICK_SUGGESTIONS,
	type UserDesignPreferences,
	formatDesignOptions,
	getDesignIntro,
} from "./prompts.js";
import {
	DesignSuggester,
	type DesignSuggestion,
	type SuggesterConfig,
	type SuggestionResult,
	createSuggester,
	getAvailableDesignSystems,
	suggestDesignSystems,
} from "./suggester.js";

// ============================================
// Types
// ============================================

export interface DesignAgentConfig {
	/** Minimum confidence to trigger intervention */
	minConfidence?: number;
	/** Maximum suggestions to present */
	maxSuggestions?: number;
	/** User's stored preferences */
	preferences?: UserDesignPreferences;
	/** Working directory for project analysis */
	workingDirectory?: string;
	/** Auto-select default if user doesn't respond */
	autoSelectTimeout?: number;
	/** Enable verbose logging */
	verbose?: boolean;
}

export interface DesignAgentState {
	isActive: boolean;
	currentTask: string | null;
	detection: DetectionResult | null;
	suggestions: SuggestionResult | null;
	selectedDesign: DesignSuggestion | null;
	phase:
		| "idle"
		| "detecting"
		| "suggesting"
		| "awaiting-choice"
		| "applying"
		| "complete";
}

export interface DesignAvenue {
	id: string;
	name: string;
	description: string;
	probability: number;
	designSystem: DesignSuggestion;
	triggers: string[];
}

// ============================================
// Design Agent
// ============================================

export class DesignAgent extends EventEmitter {
	private config: Required<DesignAgentConfig>;
	private detector: DesignDecisionDetector;
	private suggester: DesignSuggester;
	private state: DesignAgentState;

	constructor(config: DesignAgentConfig = {}) {
		super();

		this.config = {
			minConfidence: config.minConfidence ?? 0.6,
			maxSuggestions: config.maxSuggestions ?? 3,
			preferences: config.preferences ?? {},
			workingDirectory: config.workingDirectory ?? process.cwd(),
			autoSelectTimeout: config.autoSelectTimeout ?? 0,
			verbose: config.verbose ?? false,
		};

		this.detector = createDetector({
			minConfidence: this.config.minConfidence,
			workingDirectory: this.config.workingDirectory,
		});

		this.suggester = createSuggester({
			maxSuggestions: this.config.maxSuggestions,
			preferences: this.config.preferences,
		});

		this.state = {
			isActive: false,
			currentTask: null,
			detection: null,
			suggestions: null,
			selectedDesign: null,
			phase: "idle",
		};

		// Forward events
		this.detector.on("detected", (result: DetectionResult) => {
			this.emit("detected", result);
		});

		this.suggester.on("suggested", (result: SuggestionResult) => {
			this.emit("suggested", result);
		});

		this.suggester.on("choice", (id: string) => {
			this.emit("choice", id);
		});
	}

	/**
	 * Main entry point: Process a task and potentially intervene with design suggestions
	 */
	async process(task: string): Promise<{
		needsIntervention: boolean;
		message: string;
		suggestions?: DesignSuggestion[];
		state: DesignAgentState;
	}> {
		this.state.currentTask = task;
		this.state.phase = "detecting";
		this.state.isActive = true;

		this.log(`Processing task: ${task.slice(0, 50)}...`);

		// Step 1: Detect if design decision is needed
		const detection = await this.detector.detect(task);
		this.state.detection = detection;

		if (!detection.needsDesign) {
			this.state.phase = "idle";
			this.state.isActive = false;
			return {
				needsIntervention: false,
				message: "No design decisions needed for this task.",
				state: this.getState(),
			};
		}

		this.log(
			`Design detected: ${detection.reason} (${Math.round(detection.confidence * 100)}%)`,
		);

		// Step 2: Generate suggestions
		this.state.phase = "suggesting";
		const suggestions = await this.suggester.suggest(detection);
		this.state.suggestions = suggestions;
		this.state.phase = "awaiting-choice";

		// Format message
		const message = this.suggester.formatForDisplay(suggestions);

		return {
			needsIntervention: true,
			message,
			suggestions: suggestions.suggestions,
			state: this.getState(),
		};
	}

	/**
	 * Quick check if a task needs design intervention
	 */
	quickCheck(task: string): boolean {
		return needsDesignDecision(task);
	}

	/**
	 * Handle user's design choice
	 */
	async selectDesign(choiceInput: string | number): Promise<{
		success: boolean;
		selectedDesign: DesignSuggestion | null;
		commands: string[];
		steps: string[];
		message: string;
	}> {
		if (!this.state.suggestions) {
			return {
				success: false,
				selectedDesign: null,
				commands: [],
				steps: [],
				message: "No suggestions available. Run process() first.",
			};
		}

		this.state.phase = "applying";

		// Parse choice
		let selectedIndex: number;
		if (typeof choiceInput === "number") {
			selectedIndex = choiceInput - 1;
		} else {
			// Try to match by name or number
			const asNum = Number.parseInt(choiceInput, 10);
			if (!isNaN(asNum)) {
				selectedIndex = asNum - 1;
			} else {
				// Find by name
				selectedIndex = this.state.suggestions.suggestions.findIndex(
					(s) =>
						s.name.toLowerCase().includes(choiceInput.toLowerCase()) ||
						s.id.toLowerCase().includes(choiceInput.toLowerCase()),
				);
			}
		}

		// Validate index
		if (
			selectedIndex < 0 ||
			selectedIndex >= this.state.suggestions.suggestions.length
		) {
			return {
				success: false,
				selectedDesign: null,
				commands: [],
				steps: [],
				message: `Invalid choice. Please select 1-${this.state.suggestions.suggestions.length}.`,
			};
		}

		const selected = this.state.suggestions.suggestions[selectedIndex];
		this.state.selectedDesign = selected;

		// Record choice for learning
		this.suggester.recordChoice(selected.id);

		// Get setup info
		const setupInfo = await this.suggester.applyDesign(selected.id);

		this.state.phase = "complete";

		const message = FOLLOW_UP_PROMPTS.confirmed(selected.name);

		this.emit("designSelected", {
			design: selected,
			commands: setupInfo.commands,
			steps: setupInfo.steps,
		});

		return {
			success: true,
			selectedDesign: selected,
			commands: setupInfo.commands,
			steps: setupInfo.steps,
			message,
		};
	}

	/**
	 * Use default/recommended design
	 */
	async useDefault(): Promise<{
		success: boolean;
		selectedDesign: DesignSuggestion | null;
		commands: string[];
		steps: string[];
		message: string;
	}> {
		return this.selectDesign(1);
	}

	/**
	 * Skip design selection entirely
	 */
	skip(): { message: string } {
		this.state.phase = "complete";
		this.state.isActive = false;

		this.emit("skipped");

		return {
			message: FOLLOW_UP_PROMPTS.noPreference,
		};
	}

	/**
	 * Generate design avenues for the planning system
	 */
	generateDesignAvenues(): DesignAvenue[] {
		if (!this.state.detection || !this.state.suggestions) {
			return [];
		}

		return this.state.suggestions.suggestions.map((suggestion, index) => ({
			id: `design-avenue-${suggestion.id}`,
			name: `Design: ${suggestion.name}`,
			description: suggestion.description,
			probability: Math.max(0.3, 0.8 - index * 0.2),
			designSystem: suggestion,
			triggers: suggestion.stack.map((s) => s.toLowerCase()),
		}));
	}

	/**
	 * Get current state
	 */
	getState(): DesignAgentState {
		return { ...this.state };
	}

	/**
	 * Reset agent state
	 */
	reset(): void {
		this.state = {
			isActive: false,
			currentTask: null,
			detection: null,
			suggestions: null,
			selectedDesign: null,
			phase: "idle",
		};
		this.emit("reset");
	}

	/**
	 * Update user preferences
	 */
	updatePreferences(preferences: Partial<UserDesignPreferences>): void {
		this.config.preferences = {
			...this.config.preferences,
			...preferences,
		};
		this.suggester.updatePreferences(preferences);
	}

	/**
	 * Get formatted status for display
	 */
	formatStatus(): string {
		const { phase, detection, suggestions, selectedDesign } = this.state;

		switch (phase) {
			case "idle":
				return "Design Agent: Ready";
			case "detecting":
				return "Design Agent: Analyzing task...";
			case "suggesting":
				return "Design Agent: Generating suggestions...";
			case "awaiting-choice":
				return `Design Agent: Awaiting choice (${suggestions?.suggestions.length || 0} options)`;
			case "applying":
				return `Design Agent: Applying ${selectedDesign?.name}...`;
			case "complete":
				return selectedDesign
					? `Design Agent: Using ${selectedDesign.name}`
					: "Design Agent: Complete (no design selected)";
			default:
				return "Design Agent: Unknown state";
		}
	}

	/**
	 * Logging helper
	 */
	private log(message: string): void {
		if (this.config.verbose) {
			console.log(`[DesignAgent] ${message}`);
		}
	}
}

// ============================================
// Integration with Planning System
// ============================================

/**
 * Hook into the planning phase
 * Call this when a new task is received, BEFORE generating the execution plan
 */
export async function interceptForDesign(
	task: string,
	config?: DesignAgentConfig,
): Promise<{
	shouldIntercept: boolean;
	agent?: DesignAgent;
	message?: string;
	suggestions?: DesignSuggestion[];
}> {
	// Quick check first
	if (!needsDesignDecision(task)) {
		return { shouldIntercept: false };
	}

	// Full analysis
	const agent = new DesignAgent(config);
	const result = await agent.process(task);

	if (!result.needsIntervention) {
		return { shouldIntercept: false };
	}

	return {
		shouldIntercept: true,
		agent,
		message: result.message,
		suggestions: result.suggestions,
	};
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a design agent instance
 */
export function createDesignAgent(config?: DesignAgentConfig): DesignAgent {
	return new DesignAgent(config);
}

// ============================================
// Re-exports
// ============================================

export {
	// Detector
	DesignDecisionDetector,
	createDetector,
	detectDesignNeed,
	needsDesignDecision,
	type DetectionResult,
	type DesignCategory,
	type DetectorConfig,
	// Suggester
	DesignSuggester,
	createSuggester,
	suggestDesignSystems,
	getAvailableDesignSystems,
	type DesignSuggestion,
	type SuggestionResult,
	type SuggesterConfig,
	// Prompts
	type ProjectType,
	type UserDesignPreferences,
	QUICK_SUGGESTIONS,
	getDesignIntro,
	formatDesignOptions,
	FOLLOW_UP_PROMPTS,
};

// ============================================
// Default Export
// ============================================

export default {
	DesignAgent,
	createDesignAgent,
	interceptForDesign,

	// Sub-modules
	DesignDecisionDetector,
	DesignSuggester,

	// Factories
	createDetector,
	createSuggester,

	// Utilities
	needsDesignDecision,
	detectDesignNeed,
	suggestDesignSystems,
	getAvailableDesignSystems,
};
