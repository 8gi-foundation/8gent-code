/**
 * 8gent Code - Design System Suggester
 *
 * Suggests appropriate design systems based on project type,
 * user preferences, and task requirements.
 *
 * Integrates with:
 * - Local design system database
 * - User preference history
 * - Avenue tracking for multi-path suggestions
 */

import { EventEmitter } from "events";
import type { ProjectType, UserDesignPreferences } from "./prompts.js";
import {
	QUICK_SUGGESTIONS,
	getDesignIntro,
	formatDesignOptions,
	FOLLOW_UP_PROMPTS,
} from "./prompts.js";
import type { DetectionResult, DesignCategory } from "./detector.js";

// ============================================
// Types
// ============================================

export interface DesignSuggestion {
	id: string;
	name: string;
	description: string;
	reasoning: string;
	score: number; // 0-100 match score
	stack: string[];
	category: DesignCategory[];
	preview?: DesignPreview;
	installCommands?: string[];
	setupSteps?: string[];
}

export interface DesignPreview {
	type: "ascii" | "colors" | "components";
	content: string;
}

export interface SuggesterConfig {
	/** Maximum suggestions to return */
	maxSuggestions?: number;
	/** Minimum score to include */
	minScore?: number;
	/** User's stored preferences */
	preferences?: UserDesignPreferences;
	/** Include setup instructions */
	includeSetup?: boolean;
}

export interface SuggestionResult {
	intro: string;
	suggestions: DesignSuggestion[];
	followUp: string;
	selectedId?: string;
}

// ============================================
// Design System Database
// ============================================

/**
 * Extended design system database with detailed information
 */
const DESIGN_SYSTEMS: Record<string, Omit<DesignSuggestion, "id" | "score">> = {
	"shadcn-tailwind": {
		name: "shadcn/ui + Tailwind",
		description:
			"Clean, modern React components built on Radix UI. Copy-paste components you own.",
		reasoning:
			"Industry favorite for React apps. Beautiful defaults, fully customizable, excellent accessibility.",
		stack: ["Next.js", "React", "Tailwind CSS", "shadcn/ui", "Radix UI"],
		category: ["component-library", "color-scheme"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  [Button]  [Input    ]  [Card] │
  │  ─────────────────────────────  │
  │  Minimal • Accessible • Modern │
  ╰─────────────────────────────────╯`,
		},
		installCommands: [
			"npx create-next-app@latest my-app --typescript --tailwind --eslint",
			"npx shadcn@latest init",
			"npx shadcn@latest add button card input",
		],
		setupSteps: [
			"Initialize Next.js with Tailwind",
			"Run shadcn init to configure",
			"Add components as needed",
		],
	},

	"material-ui": {
		name: "Material UI",
		description:
			"Google's Material Design for React. Comprehensive, enterprise-ready.",
		reasoning:
			"Battle-tested in production. Huge component library. Great for complex forms and dashboards.",
		stack: ["React", "Material UI", "Emotion"],
		category: ["component-library", "color-scheme", "icons"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  ▣ Material Design             │
  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
  │  Elevation • Motion • Color    │
  ╰─────────────────────────────────╯`,
		},
		installCommands: [
			"npm install @mui/material @emotion/react @emotion/styled",
			"npm install @mui/icons-material",
		],
		setupSteps: [
			"Install MUI packages",
			"Set up theme provider",
			"Import and use components",
		],
	},

	"chakra-ui": {
		name: "Chakra UI",
		description:
			"Simple, modular component library. Excellent developer experience.",
		reasoning:
			"Fastest to get productive. Built-in dark mode. Great for MVPs and rapid prototyping.",
		stack: ["React", "Chakra UI", "Framer Motion"],
		category: ["component-library", "color-scheme", "layout-system"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  ◉ Chakra UI                   │
  │  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  │
  │  Simple • Modular • Accessible │
  ╰─────────────────────────────────╯`,
		},
		installCommands: [
			"npm install @chakra-ui/react @emotion/react @emotion/styled framer-motion",
		],
		setupSteps: [
			"Install Chakra packages",
			"Wrap app in ChakraProvider",
			"Start using components",
		],
	},

	"tailwind-custom": {
		name: "Tailwind + Custom",
		description:
			"Utility-first CSS with your own component designs. Maximum flexibility.",
		reasoning:
			"Full creative control. Build exactly what you envision. Great for unique designs.",
		stack: ["Next.js", "Tailwind CSS", "CSS"],
		category: ["layout-system", "typography"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │  Utility • Flexible • Custom   │
  │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  ╰─────────────────────────────────╯`,
		},
		installCommands: ["npx create-next-app@latest --tailwind"],
		setupSteps: [
			"Initialize with Tailwind",
			"Configure tailwind.config.js",
			"Build your components",
		],
	},

	tremor: {
		name: "Tremor",
		description:
			"Dashboard-first React library. Charts, metrics, and analytics components.",
		reasoning:
			"Purpose-built for dashboards. Beautiful charts out of the box. KPI cards included.",
		stack: ["React", "Tailwind CSS", "Tremor", "Recharts"],
		category: ["component-library", "color-scheme"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  ▁▂▃▅▆▇█ 78%  │  $12.4K  │ +8%│
  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
  │  Charts • KPIs • Analytics     │
  ╰─────────────────────────────────╯`,
		},
		installCommands: ["npm install @tremor/react"],
		setupSteps: [
			"Install Tremor",
			"Import components",
			"Build dashboard layouts",
		],
	},

	"radix-primitives": {
		name: "Radix Primitives",
		description:
			"Unstyled, accessible UI primitives. Build your design system from scratch.",
		reasoning:
			"Maximum control for design systems. Headless components you style yourself.",
		stack: ["React", "Radix UI", "Your CSS"],
		category: ["component-library"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  [   ] Primitives              │
  │  ─────────────────────────────  │
  │  Unstyled • Accessible • WAI  │
  ╰─────────────────────────────────╯`,
		},
		installCommands: [
			"npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu",
		],
		setupSteps: [
			"Install primitives you need",
			"Style them your way",
			"Build your design system",
		],
	},

	"ant-design": {
		name: "Ant Design",
		description:
			"Enterprise-grade React UI library. Comprehensive and polished.",
		reasoning:
			"Chinese enterprise standard. Excellent for data tables, forms, and admin panels.",
		stack: ["React", "Ant Design", "Less"],
		category: ["component-library", "color-scheme", "icons"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  蚂 Ant Design                 │
  │  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  │
  │  Enterprise • Polished • Rich  │
  ╰─────────────────────────────────╯`,
		},
		installCommands: ["npm install antd"],
		setupSteps: [
			"Install Ant Design",
			"Configure theme if needed",
			"Use components",
		],
	},

	"framer-motion": {
		name: "Framer Motion",
		description:
			"Production-ready animations for React. Gestures, layout, and scroll.",
		reasoning:
			"Best-in-class animation library. Makes complex animations simple.",
		stack: ["React", "Framer Motion"],
		category: ["animation"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  ◠◡◠ ➜ ◠◡◠ ➜ ◠◡◠            │
  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
  │  Motion • Gestures • Layout    │
  ╰─────────────────────────────────╯`,
		},
		installCommands: ["npm install framer-motion"],
		setupSteps: [
			"Install framer-motion",
			"Import motion components",
			"Animate everything",
		],
	},

	"ink-cli": {
		name: "Ink",
		description: "React for CLI apps. Build beautiful terminal interfaces.",
		reasoning:
			"If you know React, you can build gorgeous CLIs. Full component model.",
		stack: ["Node.js", "React", "Ink"],
		category: ["component-library"],
		preview: {
			type: "ascii",
			content: `
  ╭─────────────────────────────────╮
  │  $ ink-app                     │
  │  ▸ Option 1                    │
  │    Option 2                    │
  │    Option 3                    │
  ╰─────────────────────────────────╯`,
		},
		installCommands: ["npm install ink react"],
		setupSteps: [
			"Install Ink and React",
			"Create CLI component",
			"Render to terminal",
		],
	},
};

// ============================================
// Design Suggester Class
// ============================================

export class DesignSuggester extends EventEmitter {
	private config: Required<SuggesterConfig>;
	private userHistory: Map<string, number> = new Map();

	constructor(config: SuggesterConfig = {}) {
		super();

		this.config = {
			maxSuggestions: config.maxSuggestions ?? 3,
			minScore: config.minScore ?? 40,
			preferences: config.preferences ?? {},
			includeSetup: config.includeSetup ?? true,
		};
	}

	/**
	 * Generate suggestions based on detection result
	 */
	async suggest(detection: DetectionResult): Promise<SuggestionResult> {
		const { projectType, suggestedCategories, triggers } = detection;

		// Get intro message
		const intro = getDesignIntro(projectType);

		// Score all design systems
		const scored = this.scoreDesignSystems(
			projectType,
			suggestedCategories,
			triggers,
		);

		// Filter and sort
		const filtered = scored
			.filter((s) => s.score >= this.config.minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, this.config.maxSuggestions);

		// Create suggestion objects
		const suggestions: DesignSuggestion[] = filtered.map((item) => ({
			id: item.id,
			score: item.score,
			...DESIGN_SYSTEMS[item.id],
			installCommands: this.config.includeSetup
				? DESIGN_SYSTEMS[item.id].installCommands
				: undefined,
			setupSteps: this.config.includeSetup
				? DESIGN_SYSTEMS[item.id].setupSteps
				: undefined,
		}));

		// Fallback to quick suggestions if no matches
		if (suggestions.length === 0) {
			const quickSuggestions =
				QUICK_SUGGESTIONS[projectType] || QUICK_SUGGESTIONS.unknown;
			for (const qs of quickSuggestions.slice(0, this.config.maxSuggestions)) {
				suggestions.push({
					id: `quick-${qs.name.toLowerCase().replace(/\s+/g, "-")}`,
					name: qs.name,
					description: qs.description,
					reasoning: qs.reasoning,
					score: 60,
					stack: qs.stack,
					category: ["component-library"],
				});
			}
		}

		const result: SuggestionResult = {
			intro,
			suggestions,
			followUp: FOLLOW_UP_PROMPTS.askChoice,
		};

		this.emit("suggested", result);

		return result;
	}

	/**
	 * Score design systems for the given context
	 */
	private scoreDesignSystems(
		projectType: ProjectType,
		categories: DesignCategory[],
		triggers: string[],
	): Array<{ id: string; score: number }> {
		const scores: Array<{ id: string; score: number }> = [];

		for (const [id, system] of Object.entries(DESIGN_SYSTEMS)) {
			let score = 50; // Base score

			// Project type matching
			score += this.scoreProjectTypeMatch(id, projectType);

			// Category matching
			const categoryMatches = system.category.filter((c) =>
				categories.includes(c),
			).length;
			score += categoryMatches * 10;

			// Preference matching
			score += this.scorePreferences(system);

			// User history boost
			const historyBoost = this.userHistory.get(id) || 0;
			score += historyBoost * 5;

			// Trigger word matching
			const triggerBoost = this.scoreTriggerMatch(system.stack, triggers);
			score += triggerBoost;

			scores.push({ id, score: Math.min(100, Math.max(0, score)) });
		}

		return scores;
	}

	/**
	 * Score project type match
	 */
	private scoreProjectTypeMatch(
		systemId: string,
		projectType: ProjectType,
	): number {
		const matches: Record<ProjectType, string[]> = {
			"web-app": ["shadcn-tailwind", "chakra-ui", "material-ui"],
			"landing-page": ["tailwind-custom", "shadcn-tailwind", "framer-motion"],
			dashboard: ["tremor", "shadcn-tailwind", "ant-design"],
			"mobile-app": [],
			"component-library": ["radix-primitives", "shadcn-tailwind"],
			"cli-tool": ["ink-cli"],
			api: [],
			unknown: ["shadcn-tailwind", "tailwind-custom"],
		};

		const recommended = matches[projectType] || [];
		const index = recommended.indexOf(systemId);

		if (index === 0) return 25;
		if (index === 1) return 15;
		if (index >= 2) return 10;
		return 0;
	}

	/**
	 * Score based on user preferences
	 */
	private scorePreferences(
		system: Omit<DesignSuggestion, "id" | "score">,
	): number {
		const prefs = this.config.preferences;
		let score = 0;

		// Preferred frameworks
		if (prefs.preferredFrameworks) {
			for (const framework of prefs.preferredFrameworks) {
				if (
					system.stack.some((s) =>
						s.toLowerCase().includes(framework.toLowerCase()),
					)
				) {
					score += 15;
				}
			}
		}

		// Avoid list
		if (prefs.avoidList) {
			for (const avoid of prefs.avoidList) {
				if (
					system.stack.some((s) =>
						s.toLowerCase().includes(avoid.toLowerCase()),
					)
				) {
					score -= 30;
				}
				if (system.name.toLowerCase().includes(avoid.toLowerCase())) {
					score -= 50;
				}
			}
		}

		return score;
	}

	/**
	 * Score trigger word matches
	 */
	private scoreTriggerMatch(stack: string[], triggers: string[]): number {
		let score = 0;
		const stackLower = stack.map((s) => s.toLowerCase());

		for (const trigger of triggers) {
			if (trigger.startsWith("+")) continue;
			const triggerLower = trigger.toLowerCase();
			if (stackLower.some((s) => s.includes(triggerLower))) {
				score += 10;
			}
		}

		return score;
	}

	/**
	 * Record user's choice to improve future suggestions
	 */
	recordChoice(suggestionId: string): void {
		const current = this.userHistory.get(suggestionId) || 0;
		this.userHistory.set(suggestionId, current + 1);
		this.emit("choice", suggestionId);
	}

	/**
	 * Apply user's selected design system
	 */
	async applyDesign(suggestionId: string): Promise<{
		commands: string[];
		steps: string[];
		stack: string[];
	}> {
		const system = DESIGN_SYSTEMS[suggestionId];

		if (!system) {
			// Check if it's a quick suggestion
			return {
				commands: [],
				steps: ["Design system not found in database"],
				stack: [],
			};
		}

		return {
			commands: system.installCommands || [],
			steps: system.setupSteps || [],
			stack: system.stack,
		};
	}

	/**
	 * Format suggestions for display
	 */
	formatForDisplay(result: SuggestionResult): string {
		let output = `${result.intro}\n\n`;

		output += formatDesignOptions(
			result.suggestions.map((s) => ({
				name: s.name,
				description: s.description,
				reasoning: s.reasoning,
				preview: s.preview?.content,
			})),
		);

		output += `\n${result.followUp}`;

		return output;
	}

	/**
	 * Update preferences
	 */
	updatePreferences(preferences: Partial<UserDesignPreferences>): void {
		this.config.preferences = {
			...this.config.preferences,
			...preferences,
		};
	}
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a suggester instance
 */
export function createSuggester(config?: SuggesterConfig): DesignSuggester {
	return new DesignSuggester(config);
}

/**
 * Quick suggestion without creating a persistent instance
 */
export async function suggestDesignSystems(
	detection: DetectionResult,
	config?: SuggesterConfig,
): Promise<SuggestionResult> {
	const suggester = new DesignSuggester(config);
	return suggester.suggest(detection);
}

/**
 * Get all available design systems
 */
export function getAvailableDesignSystems(): Array<{
	id: string;
	name: string;
	stack: string[];
}> {
	return Object.entries(DESIGN_SYSTEMS).map(([id, system]) => ({
		id,
		name: system.name,
		stack: system.stack,
	}));
}

// ============================================
// Exports
// ============================================

export default {
	DesignSuggester,
	createSuggester,
	suggestDesignSystems,
	getAvailableDesignSystems,
	DESIGN_SYSTEMS,
};
