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
import { resolveOllamaBaseUrl } from "../ai/text-tool-endpoint";
import { type CommunicationStyle, isCommunicationStyle } from "./communication-style";
import { LocalServerHttpError, createOllamaServer, isOllamaEnabled } from "../local-model-server";
import { getVault, getVaultOrNull } from "../secrets";
import {
	loadSettings,
	saveSettings,
	DEFAULT_SETTINGS,
} from "../settings/index.js";

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
	| "provider-check-ollama"
	| "provider-check-lmstudio"
	| "provider-check-apfel"
	| "agent-name-orchestrator"
	| "agent-name-engineer"
	| "agent-name-qa"
	| "confirmation";

export type ProviderCheckId = "ollama" | "lmstudio" | "apfel";

/** Per-provider install hints surfaced when a provider check fails. */
export const PROVIDER_INSTALL_HINTS: Record<ProviderCheckId, string> = {
	ollama:
		"Install: https://ollama.ai (or `brew install ollama && ollama serve`). Then `ollama pull qwen3.6:27b`.",
	lmstudio:
		"Install: https://lmstudio.ai. Open it, load `google/gemma-4-26b-a4b`, click Start Server (port 1234).",
	apfel:
		"Install: `brew install arthur-ficial/tap/apfel`. Run: `apfel --serve --port 11500`.",
};

// The fixed style set lives in a leaf module so the prompt builder can check it (#3487).
export type { CommunicationStyle } from "./communication-style";

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
	 * Render mode.
	 *   "text" (default)       — free-text prompt via CommandInput.
	 *   "select"               — scrollable arrow-key list + digit shortcut.
	 *   "providerCheck"        — probes a local inference engine and shows a
	 *                            status row. Carries `provider` + `installHint`.
	 *   "agentName"            — renames an agent role. Carries `roleKey` so
	 *                            the renderer can show the current default.
	 */
	kind?: "text" | "select" | "providerCheck" | "agentName";
	/**
	 * What the input shows while this question waits for a typed answer, so
	 * the box says what to type ("Your name"), not "ask a question".
	 */
	placeholder?: string;
	/**
	 * Structured choices for kind: "select". When present, the renderer uses
	 * these to build the list. The free-text {options} array stays around for
	 * back-compat input validation against typed answers.
	 */
	choices?: OnboardingChoice[];
	options?: string[];
	/**
	 * For kind === "providerCheck": which local engine to probe. The renderer
	 * looks this up against `probeProviders()` and shows a status row.
	 */
	provider?: ProviderCheckId;
	/**
	 * For kind === "providerCheck": message shown if the engine isn't running.
	 * Defaults to PROVIDER_INSTALL_HINTS[provider] when present.
	 */
	installHint?: string;
	/**
	 * For kind === "agentName": which role's display name we are setting.
	 * Maps onto `settings.agents.names[roleKey]`.
	 */
	roleKey?: "orchestrator" | "engineer" | "qa";
	/**
	 * Default value to pre-fill / accept on Enter. Used by `agentName` steps.
	 */
	default?: string;
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
	/** What the Ollama probe saw. Absent only in hand-built test fixtures. */
	ollama?: OllamaCheck;
}

/**
 * Bound on the launch-time Ollama probe (#3115). A healthy Ollama answers
 * /api/tags in ~10 ms locally (measured 8-17 ms) and well under a second on a
 * LAN, so 2.5 s is two orders of magnitude of headroom, yet short enough that
 * "could not be reached" lands while the person is still reading the welcome.
 * It sits between the house bounds for the same probe: 2 s in
 * detectBestLocalProvider and the LM Studio check, 3 s in provider-readiness.
 * Unbounded, `ollama list` against a down host took 30 s, and it ran twice.
 */
export const OLLAMA_PROBE_TIMEOUT_MS = 2500;

/**
 * Safety net for the other detection commands (git, gh, python). They are
 * local and usually answer in well under a second; `gh auth status` touches
 * the network. None of them holds the setup back any more; this only stops a
 * wedged one from keeping the detection result from ever landing.
 */
export const DETECT_COMMAND_TIMEOUT_MS = 5000;

/**
 * Result of one Ollama probe. `found` means the server answered (models may
 * be empty). `unreachable` means it did not, and says why, so the welcome can
 * say "could not be reached" instead of implying nothing is installed.
 */
export type OllamaCheck =
	| { status: "found"; host: string; models: string[] }
	| {
			status: "unreachable";
			host: string;
			reason: string;
			/** OLLAMA_HOST / OLLAMA_BASE_URL was set: the person pointed us there. */
			configured: boolean;
			/** Something is there but did not answer in time (vs. refused). */
			timedOut: boolean;
	  };

/**
 * Ask the configured Ollama for its models over HTTP, bounded. Same host
 * resolution as the rest of the app (OLLAMA_BASE_URL, then OLLAMA_HOST, then
 * localhost). Never throws, never outlives `timeoutMs`.
 */
export async function probeOllama(
	opts: {
		env?: Record<string, string | undefined>;
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<OllamaCheck> {
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const host = resolveOllamaBaseUrl(env);
	const configured = Boolean(env.OLLAMA_BASE_URL?.trim() || env.OLLAMA_HOST?.trim());
	// Another local server is selected (#3149): Ollama is off, so it is not asked.
	// Reported as an unconfigured miss, which the welcome leaves out.
	if (!isOllamaEnabled(env)) {
		return { status: "unreachable", host, reason: "not used: EIGHT_LOCAL_SERVER selects another server", configured: false, timedOut: false };
	}
	try {
		const listed = await createOllamaServer({ baseUrl: host, fetch: fetchImpl }).listModels({
			signal: AbortSignal.timeout(timeoutMs),
		});
		const models = listed.flatMap((m) => {
			const name = String(m?.name ?? "").trim();
			return name ? [name] : [];
		});
		return { status: "found", host, models };
	} catch (err) {
		if (err instanceof LocalServerHttpError) {
			return { status: "unreachable", host, reason: `answered HTTP ${err.status}`, configured, timedOut: false };
		}
		const name = (err as Error)?.name;
		const timedOut = name === "TimeoutError" || name === "AbortError";
		return {
			status: "unreachable",
			host,
			reason: timedOut ? `no answer within ${timeoutMs / 1000}s` : "connection refused or no route",
			configured,
			timedOut,
		};
	}
}

/**
 * The welcome's line about Ollama. Pending: say we are checking. Unreachable:
 * say so plainly when the person pointed us at a host, or when a host is there
 * but did not answer. A refused default localhost means no Ollama runs here,
 * and that is left out like any other miss (the found block lists hits only).
 */
export function ollamaCheckLine(check: OllamaCheck | "pending" | null): string {
	if (check === "pending") return "Checking this machine for local models...\n\n";
	if (!check || check.status === "found") return "";
	if (!check.configured && !check.timedOut) return "";
	const where = check.host.replace(/^https?:\/\//, "");
	return `Ollama at ${where} could not be reached (${check.reason}).\n\n`;
}

// ============================================
// Internal helpers
// ============================================

/**
 * Persist a user-chosen agent display name to ~/.8gent/settings.json.
 * Reads + merges so concurrent settings writes (e.g. /settings view) stay
 * consistent. Best-effort: failures are swallowed by saveSettings.
 */
function persistAgentName(
	roleKey: "orchestrator" | "engineer" | "qa",
	name: string,
): void {
	const trimmed = (name ?? "").trim();
	if (!trimmed) return;
	try {
		const current = loadSettings();
		const next = {
			...current,
			agents: {
				...current.agents,
				names: {
					...current.agents.names,
					[roleKey]: trimmed,
				},
			},
		};
		saveSettings(next);
	} catch {
		// Best-effort - settings layer is forgiving by design.
	}
}

// ============================================
// Onboarding Questions
// ============================================

export const ONBOARDING_QUESTIONS: OnboardingQuestion[] = [
	// ── 1. Welcome banner ────────────────────────────────────
	// Read-only summary of what auto-detect saw. The user just presses Enter
	// (or picks the single "Continue" item) to advance. We keep this as a
	// `select` with one option so the renderer treats it consistently with
	// other steps and the user has an obvious affordance.
	{
		step: "language",
		// {found_on_machine} lists only what detection actually found (see
		// foundOnMachine). A line per miss framed the first minute around
		// what failed.
		question:
			"Good day. I'm 8gent.\n\n" +
			"{found_on_machine}" +
			"A short setup follows, so I can serve you properly. Press Enter to begin.",
		kind: "select",
		choices: [{ label: "Press Enter to begin", value: "ok" }],
		options: ["ok", "yes", "y"],
		processor: (_answer, user) => ({
			...user,
			completedSteps: [...user.completedSteps, "language"],
		}),
	},
	// ── 2. Your name ─────────────────────────────────────────
	// Collects ONLY the user's name. Earlier versions of this step silently
	// completed identity / role / projects / model / language / telegram /
	// github / mcps in one Enter press; that's been broken back into proper
	// per-decision steps below.
	{
		step: "identity",
		question: "What should I call you?{name_default_hint}",
		placeholder: "Your name",
		processor: (answer, user) => {
			const name = answer.trim() || user.identity.name;
			return {
				...user,
				identity: { ...user.identity, name: name || user.identity.name },
				completedSteps: [...user.completedSteps, "identity"],
			};
		},
	},
	// ── 3. Your role ─────────────────────────────────────────
	{
		step: "role",
		question: "What best describes you?",
		kind: "select",
		choices: [
			{ label: "Engineer", value: "engineer", description: "Builder of software" },
			{ label: "Designer", value: "designer", description: "Crafter of interfaces" },
			{ label: "Founder", value: "founder", description: "Wearer of many hats" },
			{ label: "Hobbyist", value: "hobbyist", description: "Tinkerer, learner" },
			{ label: "Other", value: "other", description: "Something else entirely" },
		],
		options: ["engineer", "designer", "founder", "hobbyist", "other"],
		processor: (answer, user) => {
			const role = answer.trim().toLowerCase() || "engineer";
			return {
				...user,
				identity: { ...user.identity, role },
				completedSteps: [...user.completedSteps, "role"],
			};
		},
	},
	// ── 4. Project description ───────────────────────────────
	{
		step: "projects",
		question:
			"What are you working on? (one short line, optional. Press Enter to skip.)",
		placeholder: "One short line, or Enter to skip",
		processor: (answer, user) => {
			const desc = answer.trim();
			if (!desc) {
				return {
					...user,
					completedSteps: [...user.completedSteps, "projects"],
				};
			}
			return {
				...user,
				projects: {
					...user.projects,
					primary: desc,
					all: user.projects.all.includes(desc)
						? user.projects.all
						: [...user.projects.all, desc],
					descriptions: { ...user.projects.descriptions, [desc]: desc },
				},
				completedSteps: [...user.completedSteps, "projects"],
			};
		},
	},
	// ── 5. Communication style ───────────────────────────────
	{
		step: "communication",
		question: "How should I communicate with you?",
		kind: "select",
		choices: [
			{
				label: "Dry-witted, sarcastic, seriously motivational",
				value: "1",
				description: "Roast me into greatness",
			},
			{ label: "Concise & direct", value: "2", description: "Just the facts" },
			{ label: "Detailed & explanatory", value: "3", description: "Teach me as we go" },
			{ label: "Casual & friendly", value: "4", description: "We're collaborators" },
			{ label: "Formal & precise", value: "5", description: "Professional tone" },
			{
				label: "Action first",
				value: "6",
				description: "Answer first, short numbered steps, one next step at the end",
			},
		],
		options: [
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"sarcastic",
			"concise",
			"detailed",
			"casual",
			"formal",
			"action-first",
		],
		processor: (answer, user) => {
			const styleMap: Record<string, CommunicationStyle> = {
				"1": "sarcastic",
				"2": "concise",
				"3": "detailed",
				"4": "casual",
				"5": "formal",
				"6": "action-first",
				sarcastic: "sarcastic",
				concise: "concise",
				detailed: "detailed",
				casual: "casual",
				formal: "formal",
				"action-first": "action-first",
			};
			const style = styleMap[answer.toLowerCase()] || "sarcastic";
			return {
				...user,
				identity: { ...user.identity, communicationStyle: style },
				completedSteps: [...user.completedSteps, "communication"],
			};
		},
	},
	// ── 6-8. Provider checks ─────────────────────────────────
	// Each step probes one local inference engine. The renderer calls
	// probeProviders() once on entry, shows status + install hint if missing,
	// and never blocks the flow. The processor records the result on user
	// config so /diagnose can surface it later.
	{
		step: "provider-check-ollama",
		question: "Provider check: Ollama (local LLM runtime)",
		kind: "providerCheck",
		provider: "ollama",
		installHint: PROVIDER_INSTALL_HINTS.ollama,
		processor: (answer, user) => {
			const live = answer === "live";
			return {
				...user,
				integrations: {
					...user.integrations,
					ollama: {
						...user.integrations.ollama,
						available: live || user.integrations.ollama.available,
					},
				},
				completedSteps: [...user.completedSteps, "provider-check-ollama"],
			};
		},
	},
	{
		step: "provider-check-lmstudio",
		question: "Provider check: LM Studio (local LLM runtime)",
		kind: "providerCheck",
		provider: "lmstudio",
		installHint: PROVIDER_INSTALL_HINTS.lmstudio,
		processor: (answer, user) => {
			const live = answer === "live";
			return {
				...user,
				integrations: {
					...user.integrations,
					lmstudio: {
						...user.integrations.lmstudio,
						available: live || user.integrations.lmstudio.available,
					},
				},
				completedSteps: [...user.completedSteps, "provider-check-lmstudio"],
			};
		},
	},
	{
		step: "provider-check-apfel",
		question: "Provider check: apfel (Apple Foundation Model)",
		kind: "providerCheck",
		provider: "apfel",
		installHint: PROVIDER_INSTALL_HINTS.apfel,
		processor: (_answer, user) => ({
			...user,
			completedSteps: [...user.completedSteps, "provider-check-apfel"],
		}),
	},
	// ── 9-11. Agent naming ───────────────────────────────────
	// Persist user-chosen display names to settings.agents.names.{role}. The
	// TabBar (useWorkspaceTabs) and role-registry system prompt builder both
	// read these via resolveRoleName(). Pressing Enter on an empty input keeps
	// the current default.
	{
		step: "agent-name-orchestrator",
		question:
			"Name your Orchestrator agent. (default: Orchestrator)\n\n" +
			"Press Enter to keep, or type a custom name (e.g. Architect, Plato):",
		kind: "agentName",
		roleKey: "orchestrator",
		default: "Orchestrator",
		processor: (answer, user) => {
			const chosen = answer.trim() || DEFAULT_SETTINGS.agents.names.orchestrator;
			persistAgentName("orchestrator", chosen);
			return {
				...user,
				completedSteps: [...user.completedSteps, "agent-name-orchestrator"],
			};
		},
	},
	{
		step: "agent-name-engineer",
		question:
			"Name your Engineer agent. (default: Engineer)\n\n" +
			"Press Enter to keep, or type a custom name (e.g. Coder, Hephaestus):",
		kind: "agentName",
		roleKey: "engineer",
		default: "Engineer",
		processor: (answer, user) => {
			const chosen = answer.trim() || DEFAULT_SETTINGS.agents.names.engineer;
			persistAgentName("engineer", chosen);
			return {
				...user,
				completedSteps: [...user.completedSteps, "agent-name-engineer"],
			};
		},
	},
	{
		step: "agent-name-qa",
		question:
			"Name your QA agent. (default: QA)\n\n" +
			"Press Enter to keep, or type a custom name (e.g. Reviewer, Cassandra):",
		kind: "agentName",
		roleKey: "qa",
		default: "QA",
		processor: (answer, user) => {
			const chosen = answer.trim() || DEFAULT_SETTINGS.agents.names.qa;
			persistAgentName("qa", chosen);
			return {
				...user,
				completedSteps: [...user.completedSteps, "agent-name-qa"],
			};
		},
	},
	// ── Agent Personalization ────────────────────────────────
	{
		step: "voice",
		question:
			"What should your 8gent be called? (default: Eight)\n\n" +
			"This is your personal AI. Name it whatever you want.\n" +
			"Press Enter for the default, or type a name:",
		processor: (answer, user) => {
			const agentName = answer.trim() || "Eight";
			return {
				...user,
				preferences: {
					...user.preferences,
					voice: {
						...user.preferences.voice,
						// null = the most natural installed system voice. KittenTTS
						// voices are an explicit opt-in in the voice picker.
						voiceId: user.preferences.voice?.voiceId ?? null,
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
			"Your 8gent speaks with your computer's own natural voice.\n\n" +
			"Optionally, you can also install KittenTTS, a small, free, local\n" +
			"text-to-speech model. No API keys, runs on your machine.\n" +
			"Download size: ~200MB (model + dependencies)",
		kind: "select",
		// First choice is the default on Enter. Values stay "1" = KittenTTS,
		// "2" = system so typed answers keep their meaning.
		choices: [
			{
				label: "Use the natural system voice",
				value: "2",
				description: "Recommended. Clear, human-sounding, no download.",
			},
			{
				label: "Also install KittenTTS",
				value: "1",
				description: "Optional. Small local model, more robotic than system voices.",
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
			{
				label: "Natural system voice",
				value: "1",
				description: "Recommended. Your computer's most natural installed voice.",
			},
			{ label: "Samantha", value: "2", description: "System - American (macOS)" },
			{ label: "Daniel", value: "3", description: "System - British (macOS)" },
			{ label: "Moira", value: "4", description: "System - Irish (macOS)" },
			{ label: "Karen", value: "5", description: "System - Australian (macOS)" },
			{ label: "Rishi", value: "6", description: "System - Indian (macOS)" },
			{ label: "Bruno", value: "7", description: "KittenTTS - male, small local model" },
			{ label: "Bella", value: "8", description: "KittenTTS - female, small local model" },
			{ label: "Jasper", value: "9", description: "KittenTTS - male, small local model" },
			{ label: "Luna", value: "10", description: "KittenTTS - female, small local model" },
			{ label: "Rosie", value: "11", description: "KittenTTS - female, small local model" },
			{ label: "Hugo", value: "12", description: "KittenTTS - male, small local model" },
			{ label: "Kiki", value: "13", description: "KittenTTS - female, small local model" },
			{ label: "Leo", value: "14", description: "KittenTTS - male, small local model" },
		],
		options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"],
		processor: (answer, user) => {
			// "1" (the default) stores no voice id: the speech resolver then picks
			// the most natural installed system voice on each machine.
			const systemVoices: Record<string, string | null> = {
				"1": null,
				"2": "Samantha",
				"3": "Daniel",
				"4": "Moira",
				"5": "Karen",
				"6": "Rishi",
			};
			// KittenTTS voices are an explicit opt-in, never the default.
			const kittenVoices: Record<string, string> = {
				"7": "Bruno",
				"8": "Bella",
				"9": "Jasper",
				"10": "Luna",
				"11": "Rosie",
				"12": "Hugo",
				"13": "Kiki",
				"14": "Leo",
			};

			const choice = answer.trim() || "1";
			const isKitten = choice in kittenVoices;
			const voice = isKitten ? kittenVoices[choice] : (systemVoices[choice] ?? null);
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
			"- Role: {role}\n" +
			"- Project: {project}\n" +
			"- Style: {style}\n" +
			"- Provider: {provider}\n" +
			"- 8gent: {agent_name}\n" +
			"- Voice: {voice}\n" +
			"- Orchestrator: {agent_orchestrator}\n" +
			"- Engineer: {agent_engineer}\n" +
			"- QA: {agent_qa}\n\n" +
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
	/** Ollama probe state for the welcome: null before detect(), then pending, then the result. */
	private ollamaCheck: OllamaCheck | "pending" | null = null;

	constructor(workingDirectory: string = process.cwd()) {
		// Always use home dir for user config — workingDirectory varies by launch location
		this.userConfigPath = path.join(process.env.HOME || os.homedir(), ".8gent", "user.json");
		this.user = this.loadUserConfig();
	}

	/**
	 * Auto-detect user environment: git config, ollama models, gh auth.
	 * Returns detected values so onboarding can skip questions.
	 */
	static async autoDetect(
		opts: { ollama?: Promise<OllamaCheck> } = {},
	): Promise<AutoDetected> {
		const detected: AutoDetected = {
			name: null,
			email: null,
			ollamaModels: [],
			githubUsername: null,
			preferredProvider: null,
			hasPython: false,
			hasKittenTTS: false,
		};

		const run = (cmd: string) => execAsync(cmd, { timeout: DETECT_COMMAND_TIMEOUT_MS });
		const checks = await Promise.allSettled([
			// Git config name
			run("git config --global user.name 2>/dev/null").then(({ stdout }) => {
				detected.name = stdout.trim() || null;
			}),
			// Git config email
			run("git config --global user.email 2>/dev/null").then(({ stdout }) => {
				detected.email = stdout.trim() || null;
			}),
			// Ollama models: bounded HTTP probe of the configured host (#3115).
			// `ollama list` had no bound and waited 30 s on a down OLLAMA_HOST.
			(opts.ollama ?? probeOllama()).then((check) => {
				detected.ollama = check;
				if (check.status !== "found") return;
				detected.ollamaModels = check.models;
				if (detected.ollamaModels.length > 0) {
					detected.preferredProvider = "ollama";
				}
			}),
			// GitHub auth
			run("gh auth status 2>&1").then(({ stdout }) => {
				const match = stdout.match(/Logged in to github.com account (\S+)/);
				detected.githubUsername = match?.[1] || null;
			}),
			// Python3 available
			run("python3 --version 2>/dev/null").then(() => {
				detected.hasPython = true;
			}),
			// KittenTTS already installed
			run('python3 -c "import kittentts" 2>/dev/null').then(() => {
				detected.hasKittenTTS = true;
			}),
		]);

		return detected;
	}

	/**
	 * Run every launch-time detection once, sharing one Ollama probe between
	 * autoDetect and detectIntegrations. The welcome reads as pending from the
	 * moment this is called, so the setup can show at once and fill in when
	 * this resolves (#3115). Never throws.
	 */
	async detect(): Promise<void> {
		this.ollamaCheck = "pending";
		const ollama = probeOllama();
		try {
			const detected = await OnboardingManager.autoDetect({ ollama });
			this.applyAutoDetected(detected);
			await this.detectIntegrations(ollama);
		} catch {
			// Detection is best effort; the setup never depends on it.
		}
		this.ollamaCheck = await ollama;
	}

	/** Where the Ollama check stands, for the welcome text. */
	getOllamaCheck(): OllamaCheck | "pending" | null {
		return this.ollamaCheck;
	}

	/**
	 * Apply auto-detected values to user config.
	 * Called before onboarding starts to pre-fill detected values.
	 */
	applyAutoDetected(detected: AutoDetected): void {
		// Fill the name only while it is empty: detection can now land after the
		// person has answered "What should I call you?", and that answer wins.
		if (detected.name && !this.user.identity.name) {
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
				const loaded = JSON.parse(content) as UserConfig;
				// #3487: a style outside the fixed set (hand-edited file, old sync)
				// is dropped, never carried into the prompt.
				const style = loaded?.identity?.communicationStyle;
				if (style != null && !isCommunicationStyle(style)) loaded.identity.communicationStyle = null;
				return loaded;
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
	 * Total number of questions in the onboarding flow. Used by the renderer
	 * to display "Step X of N". Stays accurate when questions are added or
	 * removed without anyone updating a hardcoded constant.
	 */
	getTotalSteps(): number {
		return ONBOARDING_QUESTIONS.length;
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
		return this.getClarificationArea() === "identity"
			? "I don't have your name on file. What should I call you?"
			: null;
	}

	/**
	 * The one clarification the chat may ask, or null. Only questions whose
	 * answer the TUI routes to the profile are asked in chat (#3026): a
	 * question asked as a plain message sent its answer to the model. The
	 * name is the only one routed today, and it is asked only when it is
	 * really missing (areasUnclear is never pruned, so it cannot be trusted
	 * alone).
	 */
	getClarificationArea(): "identity" | null {
		if (!this.user.understanding.areasUnclear.includes("identity")) return null;
		return this.user.identity.name ? null : "identity";
	}

	/**
	 * Store the answer to the chat's name question. Returns the stored name,
	 * or null when the text does not read as a name (a prompt typed instead,
	 * which then goes to the model as usual).
	 */
	answerNameClarification(answer: string): string | null {
		const name = asName(answer);
		if (!name) return null;
		this.user.identity.name = name;
		this.user.understanding.areasUnclear = this.user.understanding.areasUnclear.filter(
			(a) => a !== "identity",
		);
		this.user.understanding.confidenceScore = calculateConfidence(this.user);
		this.user.lastPrompted = new Date().toISOString();
		this.saveUserConfig();
		return name;
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
	async detectIntegrations(ollama?: Promise<OllamaCheck>): Promise<void> {
		// Run all checks in parallel, each one bounded
		const checks = await Promise.allSettled([
			// Check Ollama: the same bounded probe as autoDetect, shared when given.
			(ollama ?? probeOllama()).then((check) => {
				this.user.integrations.ollama =
					check.status === "found"
						? { available: true, models: check.models }
						: { available: false, models: [] };
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
			execAsync("gh auth status 2>&1", { timeout: DETECT_COMMAND_TIMEOUT_MS })
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
			? `${this.user.preferences.voice.voiceId || "natural system voice"} (${this.user.preferences.voice.engine || "system"})`
			: "disabled";
		text = text.replace("{voice}", voiceDesc);
		text = text.replace(
			"{telegram}",
			getVaultOrNull()?.has("TELEGRAM_BOT_TOKEN") ? "configured" : "not set up",
		);
		text = text.replace(
			"{found_on_machine}",
			foundOnMachine(this.user) + ollamaCheckLine(this.ollamaCheck),
		);
		text = text.replace(
			"{name_default_hint}",
			this.user.identity.name ? ` Enter keeps ${this.user.identity.name}.` : "",
		);
		text = text.replace("{agent_name}", (this.user.preferences.voice as any)?.agentName || "Eight");

		// Agent role names — pull straight from settings so the recap reflects
		// what the user just typed in steps 9-11.
		try {
			const s = loadSettings();
			const names = s?.agents?.names ?? DEFAULT_SETTINGS.agents.names;
			text = text.replace("{agent_orchestrator}", names.orchestrator);
			text = text.replace("{agent_engineer}", names.engineer);
			text = text.replace("{agent_qa}", names.qa);
		} catch {
			text = text.replace(
				"{agent_orchestrator}",
				DEFAULT_SETTINGS.agents.names.orchestrator,
			);
			text = text.replace(
				"{agent_engineer}",
				DEFAULT_SETTINGS.agents.names.engineer,
			);
			text = text.replace("{agent_qa}", DEFAULT_SETTINGS.agents.names.qa);
		}

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

/**
 * A typed reply that reads as a name: one to four words, letters (any
 * script), spaces, hyphens, apostrophes and dots only, at most 40 characters.
 * "fix the failing tests" is four words but reads as a request, so common
 * request verbs at the start disqualify it.
 */
export function asName(answer: string): string | null {
	const text = answer.trim().replace(/\s+/g, " ");
	if (!text || text.length > 40 || text.startsWith("/")) return null;
	if (!/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(text)) return null;
	const words = text.split(" ");
	if (words.length > 4) return null;
	const REQUEST =
		/^(?:fix|add|make|run|write|read|show|find|build|test|check|explain|help|create|update|delete|remove|open|list|what|why|how|where|when|who|can|could|please|hi|hello|hey|yes|no|ok|okay|thanks)$/i;
	if (REQUEST.test(words[0])) return null;
	return text;
}

/** Shorten a model id for one line: drop the registry and org path. */
export function shortModelName(id: string, max = 28): string {
	const last = id.split("/").pop() || id;
	return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

/**
 * "Found on this machine" block for the welcome: only what detection found,
 * in label/value columns. Models get a hanging indent, one per line, three
 * at most, then a count. Empty string when nothing was found.
 */
export function foundOnMachine(user: UserConfig): string {
	const rows: Array<[string, string]> = [];
	if (user.identity.name) rows.push(["Name", user.identity.name]);
	if (user.integrations.github.username) rows.push(["GitHub", user.integrations.github.username]);
	if (user.preferences.model.provider) rows.push(["Provider", user.preferences.model.provider]);
	const models = user.integrations.ollama.models ?? [];
	models.slice(0, 3).forEach((m, i) => rows.push([i === 0 ? "Models" : "", shortModelName(m)]));
	if (models.length > 3) rows.push(["", `and ${models.length - 3} more`]);
	if (rows.length === 0) return "";
	const pad = 10;
	const body = rows.map(([label, value]) => `  ${label.padEnd(pad)}${value}`).join("\n");
	return `Found on this machine:\n${body}\n\n`;
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
