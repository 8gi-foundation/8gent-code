/**
 * 8gent Code - Design Decision Detector
 *
 * Detects when a task requires design decisions and should
 * trigger the Design Agent intervention.
 *
 * The detector looks for:
 * 1. UI/Frontend creation tasks
 * 2. New app/component creation
 * 3. Design-related keywords
 * 4. Absence of existing design system
 */

import { EventEmitter } from "node:events";
import type { ProjectType } from "./prompts.js";

// ============================================
// Types
// ============================================

export interface DetectionResult {
	/** Whether design intervention is needed */
	needsDesign: boolean;
	/** Confidence score 0-1 */
	confidence: number;
	/** Why we think design is needed */
	reason: string;
	/** Detected project type */
	projectType: ProjectType;
	/** Extracted keywords that triggered detection */
	triggers: string[];
	/** Suggested design categories */
	suggestedCategories: DesignCategory[];
}

export type DesignCategory =
	| "color-scheme"
	| "component-library"
	| "typography"
	| "layout-system"
	| "animation"
	| "icons"
	| "theme";

export interface DetectorConfig {
	/** Minimum confidence to trigger intervention */
	minConfidence?: number;
	/** Skip detection for these patterns */
	skipPatterns?: RegExp[];
	/** Force detection for these patterns */
	forcePatterns?: RegExp[];
	/** Working directory for project analysis */
	workingDirectory?: string;
}

// ============================================
// Trigger Keywords
// ============================================

/**
 * Keywords that strongly suggest UI/design work
 */
const STRONG_TRIGGERS: Record<string, number> = {
	// Direct UI terms
	"landing page": 0.95,
	"web app": 0.9,
	dashboard: 0.9,
	website: 0.85,
	homepage: 0.85,
	interface: 0.8,
	ui: 0.85,
	ux: 0.7,
	frontend: 0.8,
	"mobile app": 0.9,
	component: 0.7,

	// Design terms
	design: 0.6,
	theme: 0.75,
	"dark mode": 0.8,
	"light mode": 0.8,
	style: 0.5,
	layout: 0.7,
	responsive: 0.75,
	animation: 0.7,

	// Creation terms (combined with UI context)
	create: 0.3,
	build: 0.3,
	make: 0.3,
	new: 0.2,
	implement: 0.3,
	add: 0.2,
};

/**
 * Keywords that modify confidence
 */
const MODIFIERS: Record<string, number> = {
	// Increase confidence
	beautiful: 0.2,
	modern: 0.2,
	clean: 0.15,
	professional: 0.15,
	sleek: 0.2,
	minimal: 0.15,
	stunning: 0.2,
	aesthetic: 0.25,

	// Specific frameworks mentioned (lower confidence - they know what they want)
	tailwind: -0.3,
	shadcn: -0.4,
	"material ui": -0.4,
	chakra: -0.3,
	bootstrap: -0.3,

	// Backend/non-UI terms (reduce confidence)
	api: -0.3,
	database: -0.3,
	backend: -0.4,
	server: -0.3,
	cli: -0.2,
	script: -0.3,
	test: -0.2,
	fix: -0.2,
	bug: -0.3,
	refactor: -0.3,
};

/**
 * Project type detection patterns
 */
const PROJECT_PATTERNS: Record<ProjectType, RegExp[]> = {
	"web-app": [
		/web\s*app/i,
		/dashboard/i,
		/portal/i,
		/application/i,
		/saas/i,
		/admin\s*panel/i,
	],
	"landing-page": [
		/landing\s*page/i,
		/homepage/i,
		/marketing\s*(site|page)/i,
		/product\s*page/i,
		/splash\s*page/i,
	],
	dashboard: [/dashboard/i, /analytics/i, /admin/i, /monitoring/i, /metrics/i],
	"mobile-app": [
		/mobile\s*app/i,
		/ios\s*app/i,
		/android\s*app/i,
		/react\s*native/i,
		/flutter/i,
		/expo/i,
	],
	"component-library": [
		/component\s*library/i,
		/design\s*system/i,
		/ui\s*kit/i,
		/storybook/i,
	],
	"cli-tool": [/cli/i, /command\s*line/i, /terminal/i, /console\s*app/i],
	api: [/api/i, /rest/i, /graphql/i, /endpoint/i, /backend/i, /server/i],
	unknown: [],
};

// ============================================
// Design Decision Detector
// ============================================

export class DesignDecisionDetector extends EventEmitter {
	private config: Required<DetectorConfig>;

	constructor(config: DetectorConfig = {}) {
		super();

		this.config = {
			minConfidence: config.minConfidence ?? 0.6,
			skipPatterns: config.skipPatterns ?? [],
			forcePatterns: config.forcePatterns ?? [],
			workingDirectory: config.workingDirectory ?? process.cwd(),
		};
	}

	/**
	 * Analyze a task to determine if design intervention is needed
	 */
	async detect(task: string): Promise<DetectionResult> {
		const taskLower = task.toLowerCase();

		// Check skip patterns first
		for (const pattern of this.config.skipPatterns) {
			if (pattern.test(task)) {
				return this.createNegativeResult("Matched skip pattern");
			}
		}

		// Check force patterns
		for (const pattern of this.config.forcePatterns) {
			if (pattern.test(task)) {
				return this.createPositiveResult(task, "Matched force pattern", 0.95);
			}
		}

		// Calculate confidence from triggers
		let confidence = 0;
		const triggers: string[] = [];

		// Check strong triggers
		for (const [trigger, weight] of Object.entries(STRONG_TRIGGERS)) {
			if (taskLower.includes(trigger)) {
				confidence += weight;
				triggers.push(trigger);
			}
		}

		// Apply modifiers
		for (const [modifier, adjustment] of Object.entries(MODIFIERS)) {
			if (taskLower.includes(modifier)) {
				confidence += adjustment;
				if (adjustment > 0) {
					triggers.push(`+${modifier}`);
				}
			}
		}

		// Cap confidence at 1.0
		confidence = Math.min(1, Math.max(0, confidence));

		// Detect project type
		const projectType = this.detectProjectType(task);

		// Adjust confidence based on project type
		if (projectType === "api" || projectType === "cli-tool") {
			confidence *= 0.5; // Less likely to need design intervention
		}

		// Check for existing design system in project
		const hasExistingDesign = await this.checkExistingDesignSystem();
		if (hasExistingDesign) {
			confidence *= 0.3; // Already has design system
		}

		// Determine if we need design
		const needsDesign = confidence >= this.config.minConfidence;

		// Generate reason
		const reason = this.generateReason(triggers, projectType, needsDesign);

		// Determine suggested categories
		const suggestedCategories = this.suggestCategories(task, projectType);

		const result: DetectionResult = {
			needsDesign,
			confidence,
			reason,
			projectType,
			triggers,
			suggestedCategories,
		};

		// Emit event
		this.emit("detected", result);

		return result;
	}

	/**
	 * Detect project type from task
	 */
	private detectProjectType(task: string): ProjectType {
		for (const [type, patterns] of Object.entries(PROJECT_PATTERNS)) {
			for (const pattern of patterns) {
				if (pattern.test(task)) {
					return type as ProjectType;
				}
			}
		}
		return "unknown";
	}

	/**
	 * Check if project already has a design system
	 */
	private async checkExistingDesignSystem(): Promise<boolean> {
		try {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");

			const packageJsonPath = path.join(
				this.config.workingDirectory,
				"package.json",
			);

			try {
				const content = await fs.readFile(packageJsonPath, "utf-8");
				const pkg = JSON.parse(content);
				const deps = {
					...pkg.dependencies,
					...pkg.devDependencies,
				};

				// Check for common design systems
				const designSystems = [
					"@chakra-ui",
					"@mui/material",
					"@radix-ui",
					"tailwindcss",
					"@shadcn",
					"styled-components",
					"@emotion",
					"antd",
					"@mantine",
				];

				for (const system of designSystems) {
					for (const dep of Object.keys(deps)) {
						if (dep.includes(system)) {
							return true;
						}
					}
				}
			} catch {
				// package.json doesn't exist or is invalid
			}

			// Check for tailwind config
			const tailwindFiles = [
				"tailwind.config.js",
				"tailwind.config.ts",
				"tailwind.config.mjs",
			];

			for (const file of tailwindFiles) {
				try {
					await fs.access(path.join(this.config.workingDirectory, file));
					return true;
				} catch {
					// File doesn't exist
				}
			}

			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Generate human-readable reason
	 */
	private generateReason(
		triggers: string[],
		projectType: ProjectType,
		needsDesign: boolean,
	): string {
		if (!needsDesign) {
			return "Task doesn't appear to require design decisions";
		}

		const triggerList = triggers.filter((t) => !t.startsWith("+")).join(", ");
		const typeLabel =
			projectType !== "unknown" ? ` (${projectType.replace("-", " ")})` : "";

		return `Detected UI/design task${typeLabel}. Triggers: ${triggerList}`;
	}

	/**
	 * Suggest design categories to address
	 */
	private suggestCategories(
		task: string,
		projectType: ProjectType,
	): DesignCategory[] {
		const categories: DesignCategory[] = [];
		const taskLower = task.toLowerCase();

		// Always suggest component library for UI tasks
		if (
			projectType !== "api" &&
			projectType !== "cli-tool" &&
			projectType !== "unknown"
		) {
			categories.push("component-library");
		}

		// Color scheme
		if (
			taskLower.includes("dark") ||
			taskLower.includes("light") ||
			taskLower.includes("theme") ||
			taskLower.includes("color")
		) {
			categories.push("color-scheme");
		}

		// Animation
		if (
			taskLower.includes("animation") ||
			taskLower.includes("transition") ||
			taskLower.includes("motion") ||
			taskLower.includes("animate")
		) {
			categories.push("animation");
		}

		// Typography
		if (
			taskLower.includes("font") ||
			taskLower.includes("typography") ||
			taskLower.includes("text")
		) {
			categories.push("typography");
		}

		// Layout
		if (
			taskLower.includes("layout") ||
			taskLower.includes("grid") ||
			taskLower.includes("responsive")
		) {
			categories.push("layout-system");
		}

		// Icons
		if (taskLower.includes("icon")) {
			categories.push("icons");
		}

		// Default to component-library and color-scheme if empty
		if (categories.length === 0 && projectType !== "api") {
			categories.push("component-library", "color-scheme");
		}

		return categories;
	}

	/**
	 * Create a negative result
	 */
	private createNegativeResult(reason: string): DetectionResult {
		return {
			needsDesign: false,
			confidence: 0,
			reason,
			projectType: "unknown",
			triggers: [],
			suggestedCategories: [],
		};
	}

	/**
	 * Create a positive result
	 */
	private createPositiveResult(
		task: string,
		reason: string,
		confidence: number,
	): DetectionResult {
		const projectType = this.detectProjectType(task);
		return {
			needsDesign: true,
			confidence,
			reason,
			projectType,
			triggers: ["forced"],
			suggestedCategories: this.suggestCategories(task, projectType),
		};
	}

	/**
	 * Quick check without full analysis
	 */
	quickCheck(task: string): boolean {
		const taskLower = task.toLowerCase();

		// Quick negative checks
		const negativePatterns = [
			/fix\s+bug/i,
			/debug/i,
			/test/i,
			/refactor/i,
			/api\s+endpoint/i,
			/database/i,
			/backend/i,
		];

		for (const pattern of negativePatterns) {
			if (pattern.test(task)) {
				return false;
			}
		}

		// Quick positive checks
		const positivePatterns = [
			/create\s+.*\s*(app|page|site|ui)/i,
			/build\s+.*\s*(landing|dashboard|interface)/i,
			/design/i,
			/frontend/i,
			/web\s*app/i,
		];

		for (const pattern of positivePatterns) {
			if (pattern.test(task)) {
				return true;
			}
		}

		return false;
	}
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a detector instance
 */
export function createDetector(
	config?: DetectorConfig,
): DesignDecisionDetector {
	return new DesignDecisionDetector(config);
}

/**
 * Quick detection without creating a persistent instance
 */
export async function detectDesignNeed(task: string): Promise<DetectionResult> {
	const detector = new DesignDecisionDetector();
	return detector.detect(task);
}

/**
 * Quick boolean check
 */
export function needsDesignDecision(task: string): boolean {
	const detector = new DesignDecisionDetector();
	return detector.quickCheck(task);
}

// ============================================
// Exports
// ============================================

export default {
	DesignDecisionDetector,
	createDetector,
	detectDesignNeed,
	needsDesignDecision,
};
