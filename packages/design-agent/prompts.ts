/**
 * 8gent Code - Design Agent Prompts
 *
 * Conversational prompts for the Design Agent.
 * The agent should feel like a thoughtful design partner,
 * not a robotic tool.
 */

// ============================================
// Types
// ============================================

export interface DesignPromptContext {
	/** User's original task */
	task: string;
	/** Detected project type */
	projectType: ProjectType;
	/** Keywords extracted from task */
	keywords: string[];
	/** Current working directory name */
	projectName?: string;
	/** User's previous design preferences (if known) */
	preferences?: UserDesignPreferences;
}

export type ProjectType =
	| "web-app"
	| "landing-page"
	| "dashboard"
	| "mobile-app"
	| "component-library"
	| "cli-tool"
	| "api"
	| "unknown";

export interface UserDesignPreferences {
	preferredFrameworks?: string[];
	preferredColors?: "dark" | "light" | "system" | string;
	preferredStyle?: "minimal" | "bold" | "corporate" | "playful" | "elegant";
	avoidList?: string[];
}

// ============================================
// Intro Prompts
// ============================================

/**
 * Opening lines when the Design Agent intervenes.
 * These should feel conversational and helpful, not intrusive.
 */
export const DESIGN_INTROS = [
	"Hey, before we dive in, I picked a couple design directions that might work well for this...",
	"Hold on - let me suggest some design approaches before we start building...",
	"Quick thought: I've got a few design systems that would be perfect for this. Want to see?",
	"Before we write any code, let's nail down the look and feel. I have some ideas...",
	"One sec - I want to make sure we pick the right design direction first...",
	"Alright, I've analyzed what you're building. Here are some design options to consider...",
	"Let me show you some design approaches that match what you're going for...",
];

/**
 * Get a random intro based on project type
 */
export function getDesignIntro(projectType: ProjectType): string {
	const typeSpecificIntros: Record<ProjectType, string[]> = {
		"web-app": [
			"For this web app, I've got some solid design system options...",
			"Building a web app? Perfect - let's pick the right design foundation...",
		],
		"landing-page": [
			"Landing pages need impact. I've selected some high-converting design directions...",
			"For a landing page, first impressions matter. Here are some strong options...",
		],
		dashboard: [
			"Dashboards need to balance data density with clarity. Consider these approaches...",
			"For data-heavy dashboards, these design systems handle complexity well...",
		],
		"mobile-app": [
			"Mobile-first design is crucial. Here are some approaches that work great on small screens...",
			"For mobile, these design systems have excellent touch targets and gestures...",
		],
		"component-library": [
			"Building a component library? These foundations are highly extensible...",
			"For a component library, consistency is key. Consider these systematic approaches...",
		],
		"cli-tool": [
			"Even CLI tools deserve good design. Here's how we can make it feel polished...",
			"For terminal interfaces, these approaches balance aesthetics with readability...",
		],
		api: ["While APIs don't have visual UI, documentation and error messages matter. Consider..."],
		unknown: DESIGN_INTROS,
	};

	const intros = typeSpecificIntros[projectType] || DESIGN_INTROS;
	return intros[Math.floor(Math.random() * intros.length)];
}

// ============================================
// Option Presentation Prompts
// ============================================

/**
 * How to present each option
 */
export const OPTION_TEMPLATES = {
	primary: (name: string, description: string) => `**Option 1: ${name}**\n${description}`,

	secondary: (name: string, description: string) => `**Option 2: ${name}**\n${description}`,

	alternative: (name: string, description: string) => `**Or: ${name}**\n${description}`,
};

/**
 * Generate the options presentation
 */
export function formatDesignOptions(
	options: Array<{
		name: string;
		description: string;
		reasoning: string;
		preview?: string;
	}>,
): string {
	let output = "";

	options.forEach((opt, index) => {
		const optionNum = index + 1;
		output += `\n**[${optionNum}] ${opt.name}**\n`;
		output += `${opt.description}\n`;
		output += `\n_Why this works:_ ${opt.reasoning}\n`;
		if (opt.preview) {
			output += `\n${opt.preview}\n`;
		}
		output += "\n";
	});

	return output;
}

// ============================================
// Follow-up Prompts
// ============================================

export const FOLLOW_UP_PROMPTS = {
	askChoice:
		"Which direction speaks to you? (1, 2, or 3) Or tell me more about what you're envisioning.",

	needMoreInfo:
		"I need a bit more context to give you the best options. What kind of vibe are you going for?",

	confirmed: (choice: string) =>
		`Great choice! ${choice} it is. Let me set that up and we'll start building...`,

	custom: "Want to describe what you're thinking? I can suggest something tailored to your vision.",

	noPreference:
		"No preference? No worries - I'll pick something modern and clean that we can always adjust later.",
};

// ============================================
// Design System Analysis Prompts
// ============================================

/**
 * System prompt for LLM when analyzing design needs
 */
export const DESIGN_ANALYSIS_SYSTEM_PROMPT = `You are a design consultant for a coding agent. Your job is to analyze the user's task and suggest appropriate design systems and approaches.

When analyzing, consider:
1. The type of project (web app, landing page, dashboard, etc.)
2. The likely audience and use case
3. Common design patterns for this type of project
4. Available design systems and frameworks
5. Balance between customization needs and speed of development

Be conversational and helpful. Suggest 2-3 options with clear reasoning.
Never suggest more than 3 options - too many choices paralyze decisions.
Always explain WHY each option fits the project.`;

/**
 * Prompt template for design analysis
 */
export function generateAnalysisPrompt(context: DesignPromptContext): string {
	const { task, projectType, keywords, projectName, preferences } = context;

	let prompt = "Analyze this project and suggest design approaches:\n\n";
	prompt += `**Task:** ${task}\n`;
	prompt += `**Detected Type:** ${projectType}\n`;
	prompt += `**Keywords:** ${keywords.join(", ")}\n`;

	if (projectName) {
		prompt += `**Project Name:** ${projectName}\n`;
	}

	if (preferences) {
		prompt += "\n**User Preferences:**\n";
		if (preferences.preferredFrameworks?.length) {
			prompt += `- Preferred frameworks: ${preferences.preferredFrameworks.join(", ")}\n`;
		}
		if (preferences.preferredColors) {
			prompt += `- Color preference: ${preferences.preferredColors}\n`;
		}
		if (preferences.preferredStyle) {
			prompt += `- Style preference: ${preferences.preferredStyle}\n`;
		}
		if (preferences.avoidList?.length) {
			prompt += `- Avoid: ${preferences.avoidList.join(", ")}\n`;
		}
	}

	prompt += "\nSuggest 2-3 design system options with clear reasoning for each. Be conversational.";

	return prompt;
}

// ============================================
// Quick Suggestions
// ============================================

/**
 * Pre-baked design suggestions for common scenarios
 * Used when we want quick suggestions without LLM inference
 */
export const QUICK_SUGGESTIONS: Record<
	ProjectType,
	Array<{
		name: string;
		description: string;
		reasoning: string;
		stack: string[];
	}>
> = {
	"web-app": [
		{
			name: "shadcn/ui + Tailwind",
			description: "Clean, modern components with excellent accessibility. Highly customizable.",
			reasoning: "Most popular choice for React apps in 2024+. Great defaults, easy to theme.",
			stack: ["Next.js", "Tailwind CSS", "shadcn/ui", "Radix UI"],
		},
		{
			name: "Material UI + Joy UI",
			description: "Google's design system. Comprehensive component library with built-in themes.",
			reasoning: "Battle-tested, huge component library. Good for enterprise and complex forms.",
			stack: ["React", "Material UI", "Emotion"],
		},
		{
			name: "Chakra UI",
			description: "Simple, modular components with excellent DX. Built-in dark mode.",
			reasoning: "Fastest to get started with. Great for MVPs and prototypes.",
			stack: ["React", "Chakra UI", "Framer Motion"],
		},
	],
	"landing-page": [
		{
			name: "Tailwind + Custom Components",
			description: "Minimal footprint, maximum flexibility. Perfect for unique designs.",
			reasoning:
				"Landing pages need to stand out. Custom design with Tailwind gives full creative control.",
			stack: ["Next.js", "Tailwind CSS", "Framer Motion"],
		},
		{
			name: "shadcn/ui Landing Blocks",
			description: "Pre-built landing page sections: hero, features, pricing, testimonials.",
			reasoning: "Fastest path to a professional landing page. Easy to customize.",
			stack: ["Next.js", "Tailwind CSS", "shadcn/ui"],
		},
		{
			name: "Bold & Animated",
			description: "High-impact design with animations and scroll effects.",
			reasoning: "Great for creative products, agencies, or when you need to wow visitors.",
			stack: ["Next.js", "Tailwind CSS", "Framer Motion", "GSAP"],
		},
	],
	dashboard: [
		{
			name: "shadcn/ui + Recharts",
			description: "Clean data visualization with consistent components. Dark mode ready.",
			reasoning: "Best balance of aesthetics and data density. shadcn tables are excellent.",
			stack: ["Next.js", "Tailwind CSS", "shadcn/ui", "Recharts", "TanStack Table"],
		},
		{
			name: "Tremor",
			description: "Dashboard-first component library. Built for analytics and metrics.",
			reasoning: "Purpose-built for dashboards. Charts, KPIs, and tables out of the box.",
			stack: ["React", "Tailwind CSS", "Tremor"],
		},
		{
			name: "Ant Design",
			description: "Enterprise-grade design system. Comprehensive table and form components.",
			reasoning: "Chinese enterprise standard. Excellent for data-heavy admin panels.",
			stack: ["React", "Ant Design", "AntV Charts"],
		},
	],
	"mobile-app": [
		{
			name: "React Native + NativeWind",
			description: "Tailwind CSS for React Native. Familiar styling, native performance.",
			reasoning: "If you know Tailwind, you'll feel at home. Cross-platform with native feel.",
			stack: ["React Native", "Expo", "NativeWind"],
		},
		{
			name: "Tamagui",
			description: "Universal design system. Same code for web and native.",
			reasoning: "True write-once, run-everywhere. Great for apps that need web + mobile.",
			stack: ["React Native", "Tamagui", "Expo"],
		},
		{
			name: "Flutter Material 3",
			description: "Google's latest Material Design. Smooth animations, consistent look.",
			reasoning: "Excellent for apps that need to feel premium. Great on Android.",
			stack: ["Flutter", "Material 3"],
		},
	],
	"component-library": [
		{
			name: "Radix Primitives + Tailwind",
			description: "Unstyled, accessible primitives you can theme your way.",
			reasoning: "Maximum flexibility for a design system. You control every pixel.",
			stack: ["React", "Radix UI", "Tailwind CSS", "CVA"],
		},
		{
			name: "Storybook + Chromatic",
			description: "Component-driven development with visual testing.",
			reasoning: "Industry standard for component libraries. Great docs and testing.",
			stack: ["React", "Storybook", "Chromatic", "Tailwind CSS"],
		},
	],
	"cli-tool": [
		{
			name: "Ink (React for CLI)",
			description: "React components rendered in the terminal. Animations, colors, layout.",
			reasoning: "Modern CLI UX. If you know React, you can build beautiful CLIs.",
			stack: ["Node.js", "Ink", "React"],
		},
		{
			name: "Clack",
			description: "Beautiful prompts and spinners. Minimal but polished.",
			reasoning: "Simple, elegant CLI interactions. Great for wizards and prompts.",
			stack: ["Node.js", "@clack/prompts"],
		},
	],
	api: [
		{
			name: "OpenAPI + Swagger UI",
			description: "Auto-generated documentation with interactive API explorer.",
			reasoning: "Industry standard. Great for public APIs and developer experience.",
			stack: ["OpenAPI", "Swagger UI"],
		},
	],
	unknown: [
		{
			name: "shadcn/ui + Tailwind",
			description: "Safe, modern choice. Works for almost anything.",
			reasoning:
				"Can't go wrong with this. Flexible enough to adapt as you figure out what you need.",
			stack: ["Next.js", "Tailwind CSS", "shadcn/ui"],
		},
		{
			name: "Vanilla CSS + Custom",
			description: "Start simple, add frameworks as needed.",
			reasoning: "Sometimes you need to understand the requirements before committing to a system.",
			stack: ["HTML", "CSS", "JavaScript"],
		},
	],
};

// ============================================
// Exports
// ============================================

export default {
	DESIGN_INTROS,
	OPTION_TEMPLATES,
	FOLLOW_UP_PROMPTS,
	DESIGN_ANALYSIS_SYSTEM_PROMPT,
	QUICK_SUGGESTIONS,
	getDesignIntro,
	formatDesignOptions,
	generateAnalysisPrompt,
};
