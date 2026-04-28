/**
 * 8gent Code - Onboarding System
 *
 * First-run personalization. 8gent learns who you are,
 * how you work, and what you prefer.
 *
 * A proper gentleman knows his employer.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { getVault } from "../secrets";

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

export interface UserConfig {
	version: string;
	onboardingComplete: boolean;
	completedSteps: OnboardingStep[];
	lastPrompted: string | null;
	promptCount: number;

	identity: {
		name: string | null;
		role: string | null;
		communicationStyle: CommunicationStyle | null;
		language: string;
	};

	projects: {
		primary: string | null;
		all: string[];
		descriptions: Record<string, string>;
	};

	preferences: {
		voice: {
			enabled: boolean;
			engine: "system" | "kitten" | "elevenlabs" | null;
			voiceId: string | null;
		};
		model: {
			default: string | null;
			provider: "ollama" | "lmstudio" | "openai" | "anthropic" | "openrouter" | null;
			fallbacks: string[];
			preferLocal: boolean;
		};
		git: {
			autoPush: boolean;
			autoCommit: boolean;
			branchPrefix: string;
			commitStyle: "conventional" | "simple";
		};
		autonomy: {
			askThreshold: "always" | "important" | "fatal-only" | "never";
			infiniteByDefault: boolean;
		};
	};

	integrations: {
		github: {
			authenticated: boolean;
			username: string | null;
		};
		mcps: string[];
		ollama: {
			available: boolean;
			models: string[];
		};
		lmstudio: {
			available: boolean;
			models: string[];
		};
	};

	understanding: {
		confidenceScore: number;
		areasUnclear: string[];
		lastUpdated: string | null;
	};
}

export type OnboardingStep =
	| "identity"
	| "role"
	| "projects"
	| "communication"
	| "language"
	| "model"
	| "voice"
	| "voice-services"
	| "voice-picker"
	| "telegram"
	| "github"
	| "mcps"
	| "confirmation";

export type CommunicationStyle =
	| "concise" // Just the facts
	| "detailed" // Teach me as we go
	| "casual" // We're collaborators
	| "formal"; // Professional tone

export interface OnboardingChoice {
	/** Display label for the option (e.g. "Bruno (male, warm)") */
	label: string;
	/** Value passed back to the processor when selected (e.g. "1" or "Bruno") */
	value: string;
	/** Optional secondary text shown beneath the label in dim color */
	description?: string;
}

export interface OnboardingQuestion {
	step: OnboardingStep;
	question: string;
	/**
	 * Render mode. "select" means the renderer should show a scrollable
	 * arrow-key list with number-key shortcuts. "text" (default) is a free-text
	 * prompt that goes through the normal CommandInput.
	 */
	kind?: "text" | "select";
	/**
	 * Structured choices for kind: "select". When present, the renderer uses
	 * these to build the list. The free-text {options} array stays around for
	 * back-compat input validation against typed answers.
	 */
	choices?: OnboardingChoice[];
	options?: string[];
	validator?: (answer: string) => boolean;
	processor: (answer: string, user: UserConfig) => UserConfig;
}

export interface AutoDetected {
	name: string | null;
	email: string | null;
	ollamaModels: string[];
	githubUsername: string | null;
	preferredProvider: "ollama" | "lmstudio" | "openrouter" | null;
	hasPython: boolean;
	hasKittenTTS: boolean;
}

// ============================================
// Onboarding Questions
// ============================================

const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
	{
		step: "identity",
		question:
			"Good day. I'm 8gent, The Infinite Gentleman.\n\n" +
			"Here's what I detected:\n" +
			"  Name: {detected_name}\n" +
			"  Email: {detected_email}\n" +
			"  GitHub: {detected_github}\n" +
			"  Provider: {detected_provider}\n" +
			"  Models: {detected_models}\n\n" +
			"Press Enter to accept, or type your preferred name:",
		processor: (answer, user) => {
			const name = answer.trim() || user.identity.name;
			return {
				...user,
				identity: { ...user.identity, name: name || user.identity.name },
				completedSteps: [
					...user.completedSteps,
					"identity",
					"role",
					"projects",
					"model",
					"language",
					"telegram",
					"github",
					"mcps",
				],
			};
		},
	},
	{
		step: "communication",
		question: "How should I communicate with you?",
		kind: "select",
		choices: [
			{ label: "Concise & direct", value: "1", description: "Just the facts" },
			{ label: "Detailed & explanatory", value: "2", description: "Teach me as we go" },
			{ label: "Casual & friendly", value: "3", description: "We're collaborators" },
			{ label: "Formal & precise", value: "4", description: "Professional tone" },
		],
		options: ["1", "2", "3", "4", "concise", "detailed", "casual", "formal"],
		processor: (answer, user) => {
			const styleMap: Record<string, CommunicationStyle> = {
				"1": "concise",
				"2": "detailed",
				"3": "casual",
				"4": "formal",
				concise: "concise",
				detailed: "detailed",
				casual: "casual",
				formal: "formal",
			};
			const style = styleMap[answer.toLowerCase()] || "concise";
			return {
				...user,
				identity: { ...user.identity, communicationStyle: style },
				completedSteps: [...user.completedSteps, "communication"],
			};
		},
	},
	// ── Agent Personalization ────────────────────────────────
	{
		step: "voice",
		question:
			"What should your 8gent be called? (default: Eight)\n\n" +
			"This is your personal AI - name it whatever you want.\n" +
			"Press Enter for the default, or type a name:",
		processor: (answer, user) => {
			const agentName = answer.trim() || "Eight";
			return {
				...user,
				preferences: {
					...user.preferences,
					voice: {
						...user.preferences.voice,
						voiceId: user.preferences.voice?.voiceId ?? "Bruno",
						agentName,
					} as any,
				},
				completedSteps: [...user.completedSteps, "voice"],
			};
		},
	},
	{
		step: "voice-services",
		question:
			"Would you like to install AI voice services?\n\n" +
			"This downloads KittenTTS - a free, local neural text-to-speech engine.\n" +
			"No API keys needed. Runs entirely on your machine.\n" +
			"Download size: ~200MB (model + dependencies)",
		kind: "select",
		choices: [
			{
				label: "Yes, install AI voices",
				value: "1",
				description: "Recommended. Free local neural TTS via KittenTTS.",
			},
			{
				label: "No, use system voices only",
				value: "2",
				description: "Skip the download. Use macOS built-in voices.",
			},
		],
		options: ["1", "2", "yes", "no", "y", "n"],
		processor: (answer, user) => {
			const wantsAI = ["1", "yes", "y"].includes(answer.toLowerCase());
			if (wantsAI) {
				return {
					...user,
					preferences: {
						...user.preferences,
						voice: {
							...user.preferences.voice,
							enabled: true,
							engine: "kitten" as any,
							_pendingInstall: true,
						} as any,
					},
					completedSteps: [...user.completedSteps, "voice-services"],
				};
			}
			return {
				...user,
				preferences: {
					...user.preferences,
					voice: {
						...user.preferences.voice,
						enabled: true,
						engine: "system" as any,
					},
				},
				completedSteps: [...user.completedSteps, "voice-services"],
			};
		},
	},
	{
		step: "voice-picker",
		question: "Pick a voice for your agent.",
		kind: "select",
		choices: [
			{ label: "Bruno", value: "1", description: "AI - male, warm & authoritative (recommended)" },
			{ label: "Bella", value: "2", description: "AI - female, warm & clear" },
			{ label: "Jasper", value: "3", description: "AI - male, crisp & technical" },
			{ label: "Luna", value: "4", description: "AI - female, soft & creative" },
			{ label: "Rosie", value: "5", description: "AI - female, bright & energetic" },
			{ label: "Hugo", value: "6", description: "AI - male, neutral & steady" },
			{ label: "Kiki", value: "7", description: "AI - female, light & friendly" },
			{ label: "Leo", value: "8", description: "AI - male, rich & expressive" },
			{ label: "Moira", value: "9", description: "System - Irish (macOS)" },
			{ label: "Daniel", value: "10", description: "System - British (macOS)" },
			{ label: "Samantha", value: "11", description: "System - American (macOS)" },
			{ label: "Karen", value: "12", description: "System - Australian (macOS)" },
			{ label: "Rishi", value: "13", description: "System - Indian (macOS)" },
		],
		options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"],
		processor: (answer, user) => {
			const kittenVoices: Record<string, string> = {
				"1": "Bruno",
				"2": "Bella",
				"3": "Jasper",
				"4": "Luna",
				"5": "Rosie",
				"6": "Hugo",
				"7": "Kiki",
				"8": "Leo",
			};
			const systemVoices: Record<string, string> = {
				"9": "Moira",
				"10": "Daniel",
				"11": "Samantha",
				"12": "Karen",
				"13": "Rishi",
			};

			const choice = answer.trim() || "1";
			const isKitten = choice in kittenVoices;
			const voice = kittenVoices[choice] || systemVoices[choice] || "Bruno";
			const engine = isKitten ? "kitten" : "system";

			return {
				...user,
				preferences: {
					...user.preferences,
					voice: {
						...user.preferences.voice,
						enabled: true,
						engine: engine as any,
						voiceId: voice,
					},
				},
				completedSteps: [...user.completedSteps, "voice-picker"],
			};
		},
	},
	{
		step: "confirmation",
		question:
			"Excellent. All set:\n\n" +
			"- Name: {name}\n" +
			"- Style: {style}\n" +
			"- Provider: {provider}\n" +
			"- Agent: {agent_name}\n" +
			"- Voice: {voice}\n\n" +
			"Ready to begin?",
		kind: "select",
		choices: [
			{ label: "Yes, let's go", value: "yes" },
			{ label: "No, restart later", value: "no" },
		],
		options: ["yes", "no", "y", "n"],
		processor: (answer, user) => {
			// Any answer (including "no") completes onboarding - user can always
			// reconfigure later with /onboarding. Resetting the entire config here
			// caused an infinite loop (steps cleared -> questions restart -> 36/6).
			return {
				...user,
				onboardingComplete: true,
				completedSteps: [...user.completedSteps, "confirmation"],
				understanding: {
					...user.understanding,
					confidenceScore: calculateConfidence(user),
					areasUnclear: [],
					lastUpdated: new Date().toISOString(),
				},
			};
		},
	},
];

// ============================================
// Onboarding Manager
// ============================================

export class OnboardingManager {
	private userConfigPath: string;
	private user: UserConfig;

	constructor(workingDirectory: string = process.cwd()) {
		// Always use home dir for user config — workingDirectory varies by launch location
		this.userConfigPath = path.join(process.env.HOME || os.homedir(), ".8gent", "user.json");
		this.user = this.loadUserConfig();
	}

	/**
	 * Auto-detect user environment: git config, ollama models, gh auth.
	 * Returns detected values so onboarding can skip questions.
	 */
	static async autoDetect(): Promise<AutoDetected> {
		const detected: AutoDetected = {
			name: null,
			email: null,
			ollamaModels: [],
			githubUsername: null,
			preferredProvider: null,
			hasPython: false,
			hasKittenTTS: false,
		};

		const checks = await Promise.allSettled([
			// Git config name
			execAsync("git config --global user.name 2>/dev/null").then(({ stdout }) => {
				detected.name = stdout.trim() || null;
			}),
			// Git config email
			execAsync("git config --global user.email 2>/dev/null").then(({ stdout }) => {
				detected.email = stdout.trim() || null;
			}),
			// Ollama models
			execAsync("ollama list 2>/dev/null").then(({ stdout }) => {
				detected.ollamaModels = stdout
					.split("\n")
					.slice(1)
					.map((line) => line.split(/\s+/)[0])
					.filter(Boolean);
				if (detected.ollamaModels.length > 0) {
					detected.preferredProvider = "ollama";
				}
			}),
			// GitHub auth
			execAsync("gh auth status 2>&1").then(({ stdout }) => {
				const match = stdout.match(/Logged in to github.com account (\S+)/);
				detected.githubUsername = match?.[1] || null;
			}),
			// Python3 available
			execAsync("python3 --version 2>/dev/null").then(() => {
				detected.hasPython = true;
			}),
			// KittenTTS already installed
			execAsync('python3 -c "import kittentts" 2>/dev/null').then(() => {
				detected.hasKittenTTS = true;
			}),
		]);

		return detected;
	}

	/**
	 * Apply auto-detected values to user config.
	 * Called before onboarding starts to pre-fill detected values.
	 */
	applyAutoDetected(detected: AutoDetected): void {
		if (detected.name) {
			this.user.identity.name = detected.name;
		}
		if (detected.preferredProvider) {
			this.user.preferences.model.provider = detected.preferredProvider;
			this.user.preferences.model.preferLocal =
				detected.preferredProvider === "ollama" || detected.preferredProvider === "lmstudio";
		}
		if (detected.ollamaModels.length > 0) {
			this.user.integrations.ollama = {
				available: true,
				models: detected.ollamaModels,
			};
			// Set default model to first available
			if (!this.user.preferences.model.default) {
				this.user.preferences.model.default = detected.ollamaModels[0];
			}
		}
		if (detected.githubUsername) {
			this.user.integrations.github = {
				authenticated: true,
				username: detected.githubUsername,
			};
		}
		this.saveUserConfig();
	}

	private loadUserConfig(): UserConfig {
		try {
			if (fs.existsSync(this.userConfigPath)) {
				const content = fs.readFileSync(this.userConfigPath, "utf-8");
				return JSON.parse(content) as UserConfig;
			}
		} catch {
			// Fall through to default
		}
		return getDefaultUserConfig();
	}

	private saveUserConfig(): void {
		const dir = path.dirname(this.userConfigPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.userConfigPath, JSON.stringify(this.user, null, 2));
	}

	/**
	 * Check if onboarding is needed
	 */
	needsOnboarding(): boolean {
		return !this.user.onboardingComplete;
	}

	/**
	 * Check if we should ask a clarification question
	 */
	shouldAskClarification(): boolean {
		if (this.user.onboardingComplete && this.user.understanding.confidenceScore < 0.8) {
			return true;
		}
		// Also ask weekly
		if (this.user.lastPrompted) {
			const lastPrompt = new Date(this.user.lastPrompted);
			const daysSince = (Date.now() - lastPrompt.getTime()) / (1000 * 60 * 60 * 24);
			if (daysSince > 7) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get the next onboarding question
	 */
	getNextQuestion(): OnboardingQuestion | null {
		if (this.user.onboardingComplete) {
			return null;
		}

		for (const question of ONBOARDING_QUESTIONS) {
			if (!this.user.completedSteps.includes(question.step)) {
				return this.interpolateQuestion(question);
			}
		}

		return null;
	}

	/**
	 * Get a clarification question for incomplete understanding
	 */
	getClarificationQuestion(): string | null {
		const unclear = this.user.understanding.areasUnclear[0];
		if (!unclear) return null;

		const clarifications: Record<string, string> = {
			identity: "I don't have your name on file. What should I call you?",
			projects: "What project are you primarily working on?",
			preferences: "How would you like me to communicate with you?",
			integrations: "Are you using local models (Ollama/LM Studio) or cloud?",
		};

		return clarifications[unclear] || null;
	}

	/**
	 * Process an answer to the current question
	 */
	processAnswer(answer: string): {
		success: boolean;
		nextQuestion: OnboardingQuestion | null;
	} {
		const currentQuestion = this.getNextQuestion();
		if (!currentQuestion) {
			return { success: false, nextQuestion: null };
		}

		// Validate if validator exists
		if (currentQuestion.validator && !currentQuestion.validator(answer)) {
			return { success: false, nextQuestion: currentQuestion };
		}

		// Process the answer
		this.user = currentQuestion.processor(answer, this.user);
		this.user.promptCount++;
		this.user.lastPrompted = new Date().toISOString();
		this.saveUserConfig();

		return { success: true, nextQuestion: this.getNextQuestion() };
	}

	/**
	 * Skip current question
	 */
	skipQuestion(): OnboardingQuestion | null {
		const current = this.getNextQuestion();
		if (current) {
			this.user.completedSteps.push(current.step);
			this.user.understanding.areasUnclear.push(current.step);
			this.saveUserConfig();
		}
		return this.getNextQuestion();
	}

	/**
	 * Skip all remaining questions
	 */
	skipAll(): void {
		this.user.onboardingComplete = true;
		this.user.understanding.confidenceScore = calculateConfidence(this.user);
		this.saveUserConfig();
	}

	/**
	 * Get current user config
	 */
	getUser(): UserConfig {
		return { ...this.user };
	}

	/**
	 * Update specific user preferences
	 */
	updatePreferences(updates: Partial<UserConfig["preferences"]>): void {
		this.user.preferences = { ...this.user.preferences, ...updates };
		this.user.understanding.lastUpdated = new Date().toISOString();
		this.saveUserConfig();
	}

	/**
	 * Install KittenTTS - pip install + warm up the model.
	 * Called after user opts in during onboarding.
	 * Returns true if installation succeeded.
	 */
	async installKittenTTS(onProgress?: (message: string) => void): Promise<boolean> {
		onProgress?.("Checking Python...");

		// Verify python3 is available
		try {
			await execAsync("python3 --version 2>/dev/null");
		} catch {
			onProgress?.("Python 3 not found. Install Python first: https://python.org");
			return false;
		}

		// Check if already installed
		try {
			await execAsync('python3 -c "import kittentts" 2>/dev/null');
			onProgress?.("KittenTTS already installed.");
		} catch {
			// Install kittentts
			onProgress?.("Installing KittenTTS (this may take a minute)...");
			try {
				await execAsync("python3 -m pip install --quiet kittentts 2>&1", {
					timeout: 120_000,
				});
				onProgress?.("KittenTTS installed.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				onProgress?.(`Install failed: ${msg}`);
				return false;
			}
		}

		// Warm up the model (downloads on first use)
		onProgress?.("Downloading voice model (first time only)...");
		try {
			await execAsync(
				"python3 -c \"from kittentts import KittenTTS; m = KittenTTS('KittenML/kitten-tts-nano-0.8'); m.generate_to_file('Hello, I am ready.', '/tmp/kitten-warmup.wav', voice='Bruno')\" 2>&1",
				{ timeout: 120_000 },
			);
			// Clean up warmup file
			try {
				await execAsync("rm /tmp/kitten-warmup.wav 2>/dev/null");
			} catch {}
			onProgress?.("Voice model ready.");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onProgress?.(`Model download failed: ${msg}. Voice will download on first use.`);
			// Not a hard failure - model will download on first actual use
		}

		// Update config
		this.user.preferences.voice.engine = "kitten" as any;
		if (!this.user.preferences.voice.voiceId) {
			this.user.preferences.voice.voiceId = "Bruno";
		}
		this.saveUserConfig();
		return true;
	}

	/**
	 * Check if KittenTTS install is pending from onboarding.
	 */
	hasPendingInstall(): boolean {
		return !!(this.user.preferences.voice as any)?._pendingInstall;
	}

	/**
	 * Clear the pending install flag after installation completes.
	 */
	clearPendingInstall(): void {
		const voice = this.user.preferences.voice as any;
		if (voice._pendingInstall) {
			voice._pendingInstall = undefined;
			this.saveUserConfig();
		}
	}

	/**
	 * Reset onboarding completely
	 */
	reset(): void {
		this.user = getDefaultUserConfig();
		this.saveUserConfig();
	}

	/**
	 * Detect available integrations (non-blocking)
	 */
	async detectIntegrations(): Promise<void> {
		// Run all checks in parallel, non-blocking
		const checks = await Promise.allSettled([
			// Check Ollama
			execAsync("ollama list 2>/dev/null")
				.then(({ stdout }) => {
					const models = stdout
						.split("\n")
						.slice(1)
						.map((line) => line.split(/\s+/)[0])
						.filter(Boolean);
					this.user.integrations.ollama = { available: true, models };
				})
				.catch(() => {
					this.user.integrations.ollama = { available: false, models: [] };
				}),

			// Check LM Studio
			fetch("http://localhost:1234/v1/models", {
				signal: AbortSignal.timeout(2000),
			})
				.then(async (response) => {
					if (response.ok) {
						const data = await response.json();
						const models = data.data?.map((m: any) => m.id) || [];
						this.user.integrations.lmstudio = { available: true, models };
					}
				})
				.catch(() => {
					this.user.integrations.lmstudio = { available: false, models: [] };
				}),

			// Check GitHub
			execAsync("gh auth status 2>&1")
				.then(({ stdout }) => {
					const usernameMatch = stdout.match(/Logged in to github.com account (\S+)/);
					this.user.integrations.github = {
						authenticated: true,
						username: usernameMatch?.[1] || null,
					};
				})
				.catch(() => {
					this.user.integrations.github = {
						authenticated: false,
						username: null,
					};
				}),
		]);

		this.saveUserConfig();
	}

	/**
	 * Interpolate user values into question text
	 */
	private interpolateQuestion(question: OnboardingQuestion): OnboardingQuestion {
		let text = question.question;
		text = text.replace("{name}", this.user.identity.name || "friend");
		text = text.replace("{role}", this.user.identity.role || "developer");
		text = text.replace("{project}", this.user.projects.primary || "your project");
		text = text.replace("{style}", this.user.identity.communicationStyle || "concise");
		text = text.replace("{language}", this.user.identity.language || "en");
		text = text.replace("{provider}", this.user.preferences.model.provider || "ollama");
		const voiceDesc = this.user.preferences.voice.enabled
			? `${this.user.preferences.voice.voiceId || "Bruno"} (${this.user.preferences.voice.engine || "system"})`
			: "disabled";
		text = text.replace("{voice}", voiceDesc);
		text = text.replace(
			"{telegram}",
			getVault().has("TELEGRAM_BOT_TOKEN") ? "configured" : "not set up",
		);
		text = text.replace("{detected_name}", this.user.identity.name || "not detected");
		text = text.replace(
			"{detected_email}",
			this.user.integrations?.github?.username ? "(via git)" : "not detected",
		);
		text = text.replace(
			"{detected_github}",
			this.user.integrations.github.username || "not detected",
		);
		text = text.replace(
			"{detected_provider}",
			this.user.preferences.model.provider || "not detected",
		);
		text = text.replace(
			"{detected_models}",
			this.user.integrations.ollama.models.slice(0, 3).join(", ") || "none found",
		);
		text = text.replace("{agent_name}", (this.user.preferences.voice as any)?.agentName || "Eight");

		return { ...question, question: text };
	}
}

// ============================================
// Helpers
// ============================================

function getDefaultUserConfig(): UserConfig {
	return {
		version: "0.1.0",
		onboardingComplete: false,
		completedSteps: [],
		lastPrompted: null,
		promptCount: 0,
		identity: {
			name: null,
			role: null,
			communicationStyle: null,
			language: "en",
		},
		projects: {
			primary: null,
			all: [],
			descriptions: {},
		},
		preferences: {
			voice: {
				enabled: false,
				engine: null,
				voiceId: null,
			},
			model: {
				default: null,
				provider: null,
				fallbacks: [],
				preferLocal: true,
			},
			git: {
				autoPush: false,
				autoCommit: true,
				branchPrefix: "8gent/",
				commitStyle: "conventional",
			},
			autonomy: {
				askThreshold: "fatal-only",
				infiniteByDefault: false,
			},
		},
		integrations: {
			github: {
				authenticated: false,
				username: null,
			},
			mcps: [],
			ollama: {
				available: false,
				models: [],
			},
			lmstudio: {
				available: false,
				models: [],
			},
		},
		understanding: {
			confidenceScore: 0,
			areasUnclear: ["identity", "projects", "preferences", "integrations"],
			lastUpdated: null,
		},
	};
}

function calculateConfidence(user: UserConfig): number {
	let score = 0;

	// Identity: 20%
	if (user.identity.name) score += 0.1;
	if (user.identity.role) score += 0.05;
	if (user.identity.communicationStyle) score += 0.05;

	// Projects: 20%
	if (user.projects.primary) score += 0.15;
	if (user.projects.all.length > 0) score += 0.05;

	// Preferences: 20%
	if (user.preferences.model.provider) score += 0.1;
	if (user.preferences.model.default) score += 0.05;
	if (user.preferences.voice.enabled !== null) score += 0.05;

	// Integrations: 20%
	if (user.integrations.ollama.available || user.integrations.lmstudio.available) score += 0.1;
	if (user.integrations.github.authenticated) score += 0.1;

	// Usage patterns: 20% (learned over time)
	// This increases as the user interacts more
	const interactions = Math.min(user.promptCount / 50, 1);
	score += interactions * 0.2;

	return Math.min(score, 1);
}

// ============================================
// Telegram Setup Flow (deterministic, no LLM)
// ============================================

/**
 * Interactive Telegram setup. Reads token via stdin (not LLM).
 * Stores the token in the encrypted SecretVault.
 *
 * @param rl - readline interface for stdin input
 * @returns true if setup completed, false if cancelled
 */
export async function runTelegramSetup(rl: import("readline").Interface): Promise<boolean> {
	const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

	console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║          Telegram Bot Setup                      ║
╚══════════════════════════════════════════════════╝\x1b[0m

\x1b[33mStep 1:\x1b[0m Open Telegram and search for @BotFather
\x1b[33mStep 2:\x1b[0m Send /newbot and follow the prompts
\x1b[33mStep 3:\x1b[0m Copy the bot token (looks like 123456:ABC-DEF...)
`);

	const token = (await ask("\x1b[36mPaste your bot token:\x1b[0m ")).trim();
	if (!token || token.length < 20) {
		console.log("\x1b[31mInvalid token. Setup cancelled.\x1b[0m");
		return false;
	}

	// Validate the token against Telegram API
	console.log("\x1b[90mValidating token...\x1b[0m");
	try {
		const { validateToken } = await import("../telegram");
		const result = await validateToken(token);
		if (!result.valid) {
			console.log(`\x1b[31mToken invalid: ${result.error}\x1b[0m`);
			return false;
		}
		console.log(`\x1b[32mToken valid! Bot: @${result.username}\x1b[0m`);
	} catch {
		console.log("\x1b[33mCouldn't validate token (network error). Storing anyway.\x1b[0m");
	}

	// Store in vault
	const vault = getVault();
	vault.set("TELEGRAM_BOT_TOKEN", token);
	console.log("\x1b[32mToken encrypted with AES-256-GCM and stored in vault.\x1b[0m");
	console.log("\x1b[90mYour token is never exposed to the AI.\x1b[0m");

	// Chat ID
	console.log(`
\x1b[33mChat ID (optional):\x1b[0m
To restrict who can control your bot, you can add your Telegram user/chat ID.
To find it: message @userinfobot on Telegram, it will reply with your ID.
Leave blank to allow all users.
`);

	const chatId = (
		await ask("\x1b[36mYour Telegram chat ID (or press Enter to skip):\x1b[0m ")
	).trim();
	if (chatId && /^\d+$/.test(chatId)) {
		vault.set("TELEGRAM_CHAT_ID", chatId);
		console.log(`\x1b[32mChat ID stored.\x1b[0m Only user ${chatId} can control the bot.`);
	} else if (chatId) {
		console.log("\x1b[33mInvalid chat ID (must be numeric). Skipped.\x1b[0m");
	}

	console.log(`
\x1b[32mTelegram setup complete!\x1b[0m
Use \x1b[36m/telegram start\x1b[0m to launch the bot, or it will auto-start next session.
`);

	return true;
}

// ============================================
// Exports
// ============================================

export default {
	OnboardingManager,
	getDefaultUserConfig,
	runTelegramSetup,
};
