/**
 * 8gent Code - Main App Component
 *
 * Fully animated TUI with:
 * - Gradient headers
 * - Typing animations
 * - Progress indicators
 * - Sound effects
 * - Rainbow borders
 * - Ghost text suggestions (Tab to accept)
 * - Slash commands (/kanban, /predict, /avenues)
 * - Proactive planning engine
 * - Multi-avenue tracking
 */

import { Box, useApp, useInput } from "ink";
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
	type TaskCategory,
	getRouterStats,
	getTaskRouter,
} from "../../../packages/ai/task-router.js";
import { SessionManager } from "../../../packages/eight/session-manager.js";
import { SessionTree } from "../../../packages/eight/session-tree.js";
import { critiqueResponse } from "../../../packages/orchestration/sequential-pipeline.js";
import {
	ActivityMonitor,
	clearActivity,
	completeActivity,
	pushActivity,
} from "./components/ActivityMonitor.js";
import { TabBar } from "./components/TabBar.js";
import { IntroBanner, stopIntroMusic } from "./components/IntroBanner.js";
import { pushVisualiserToken } from "./components/ThinkingVisualizer.js";
import { setVisualiserTokenSink } from "../../../packages/eight/visualiser-bridge.js";
import {
	composePrompt,
	ensureInstalled,
	getPreset,
	isInstalled,
	listPresetIds,
	runExternalAgent,
} from "./lib/external-agent-runner.js";
import { ThinkingView } from "./components/ThinkingView.js";
import { VoiceIndicator } from "./components/VoiceIndicator.js";
import { AgentIndicator } from "./components/agent-panel/AgentIndicator.js";
import { AgentSidebar } from "./components/agent-panel/AgentSidebar.js";
import { SpawnRequestCard } from "./components/agent-panel/SpawnRequestCard.js";
import {
	AnimationList,
	AnimationShowcase,
	type AnimationType,
	isValidAnimation,
} from "./components/animation-showcase.js";
import { BackgroundPanel } from "./components/background-panel.js";
import {
	ADHDModeContext,
	ADHD_MODE_DISABLED_MSG,
	ADHD_MODE_ENABLED_MSG,
	ADHD_MODE_SUGGESTION,
} from "./components/bionic-text.js";
import { CommandInput } from "./components/command-input.js";
import { FixedFrame } from "./components/fixed-frame/index.js";
import { FancyHeader, Header } from "./components/header.js";
import {
	ImageBadge,
	consumeIfWholeValueIsImagePath,
	useImageInput,
} from "./components/image-input.js";
import { MessageList, StreamingMessage } from "./components/message-list.js";
import {
	AutoMiniKanban,
	AutoPlanKanban,
	AvenueDisplay,
	MiniKanban,
	PlanKanban,
	PredictedSteps,
} from "./components/plan-kanban.js";
import {
	AppText,
	Divider,
	Heading,
	Inline,
	Label,
	MutedText,
	ShortcutHint,
	Spacer,
	Stack,
} from "./components/primitives/index.js";
import {
	ProcessBadge,
	ProcessDetailView,
	ProcessSidebar,
} from "./components/process-panel/index.js";
import {
	ModelSelector,
	type ProviderOption,
	ProviderSelector,
	SelectInput,
	type SelectOption,
} from "./components/select-input.js";
import { ShortcutDock } from "./components/shortcut-dock.js";
import { playSound, soundManager } from "./components/sound-effects.js";
import { DetailedStatusBar, EnhancedStatusBar, StatusBar } from "./components/status-bar.js";
import { AnimatedStatusVerb } from "./components/status-verb.js";
import type { TaskItem } from "./components/task-card/index.js";
import { useAgentOrchestration } from "./hooks/useAgentOrchestration.js";
import { useAutoKanban } from "./hooks/useAutoKanban.js";
import { useProcessPanel } from "./hooks/useProcessPanel.js";
import { writeToTerminal } from "./hooks/useTerminal.js";
import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
import { useViewport } from "./hooks/useViewport.js";
import { useVoiceChat } from "./hooks/useVoiceChat.js";
import { useVoiceInput } from "./hooks/useVoiceInput.js";
import { type TabType, useWorkspaceTabs } from "./hooks/useWorkspaceTabs.js";
import { resolveSpecForRole, usePerTabAgents } from "./hooks/usePerTabAgents.js";
import { type ADHDSoundscape, getADHDAudio } from "./lib/adhd-audio.js";
import { probeProviders } from "./lib/provider-health.js";
import { ROLE_REGISTRY } from "../../../packages/orchestration/role-registry.js";
import * as bgPool from "./lib/background-pool.js";
import { appendClosingQuestionIfNeeded } from "./lib/closing-prompt.js";
import { formatTokens, truncate } from "./lib/index.js";
import {
	TUI_AGENT_MODE_COMPACT_BELOW,
	computeProcessSidebarWidth,
	tuiChatContentWidth,
} from "./lib/layout-breakpoints.js";
import { narratePlan, narrateStep, narrateToolEnd, narrateToolStart } from "./lib/narrator.js";
import {
	flushSession,
	initSessionLogger,
	logError,
	logMessage,
	logStep,
	logTabSwitch,
	logToolEnd,
	logToolStart,
} from "./lib/session-logger.js";
import { expandSkillSlashCommand } from "./lib/skill-slash.js";
import type { SlashCommand } from "./lib/slash-commands.js";
import { getSkillSummary, getSlashRegistry } from "./lib/slash-registry.js";
import { BTWView } from "./screens/BTWView.js";
import { IdeasView } from "./screens/IdeasView.js";
import { MusicPlayerView } from "./screens/MusicPlayerView.js";
import { HudMusicPlayer } from "./components/HudMusicPlayer.js";
import { NotesView } from "./screens/NotesView.js";
import { OnboardingScreen } from "./screens/OnboardingScreen.js";
import { ProjectsView } from "./screens/ProjectsView.js";
import { QuestionsView } from "./screens/QuestionsView.js";
import { SettingsView } from "./screens/SettingsView.js";
import { TerminalView } from "./screens/TerminalView.js";
import {
	loadSettings as loadAppSettings,
	getVoiceForRole,
} from "../../../packages/settings/index.js";
import { NarratorView } from "./screens/index.js";

// Import auth + DB systems (lazy, non-blocking)
let authManager: any = null;
let convexClient: any = null;

async function initAuthSystem() {
	try {
		const { getAuthManager, initAuth } = await import("../../../packages/auth/index.js");
		const state = await initAuth();
		authManager = getAuthManager();

		// If authenticated, wire up Convex
		if (state.state === "authenticated") {
			try {
				const { getConvexClient } = await import("../../../packages/db/client.js");
				convexClient = getConvexClient();
				convexClient.setAuth(async () => authManager?.getAccessToken?.() ?? null);
			} catch {}
		}

		return state;
	} catch {
		// Auth packages not available — anonymous mode
		return { state: "anonymous" as const };
	}
}

// Import permission system for infinite mode
import {
	disableInfiniteMode,
	enableInfiniteMode,
	isInfiniteMode,
} from "../../../packages/permissions/index.js";

// Import the actual Agent for real execution
import { Agent } from "../../../packages/eight/index.js";
import type {
	AgentEventCallbacks,
	AgentEvidenceEvent,
	AgentEvidenceSummaryEvent,
	AgentStepEvent,
	AgentToolEndEvent,
	AgentToolStartEvent,
} from "../../../packages/eight/index.js";

// Load .env file if present
import * as fs from "node:fs";
import * as pathMod from "node:path";
import {
	isLikelyEmbeddingModelId,
	normalizeProviderId,
	pickBestChatModel,
} from "./lib/model-selection.js";

function loadEnvFile() {
	// Check multiple locations: cwd first, then the 8gent repo root
	const candidates = [
		pathMod.join(process.cwd(), ".env"),
		pathMod.resolve(import.meta.dirname, "../../../.env"), // 8gent-code repo root
		pathMod.join(process.env.HOME || "", ".8gent", ".env"), // ~/.8gent/.env
	];
	for (const envPath of candidates) {
		try {
			if (fs.existsSync(envPath)) {
				const content = fs.readFileSync(envPath, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith("#")) {
						const eqIdx = trimmed.indexOf("=");
						if (eqIdx > 0) {
							const key = trimmed.slice(0, eqIdx).trim();
							const val = trimmed.slice(eqIdx + 1).trim();
							if (!process.env[key]) {
								process.env[key] = val;
							}
						}
					}
				}
			}
		} catch {}
	}
}

function loadProviderSettings(): { provider: string; model: string } {
	try {
		const settingsPath = pathMod.join(
			process.env.HOME || process.env.USERPROFILE || "",
			".8gent",
			"providers.json",
		);
		if (fs.existsSync(settingsPath)) {
			const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			return {
				provider: data.activeProvider || "ollama",
				model: data.activeModel || "",
			};
		}
	} catch {}
	return { provider: "ollama", model: "" };
}

/**
 * Probe all local providers at startup and return the best available chat model + provider.
 * Priority: LM Studio → Ollama → Apfel (Apple Intelligence) → empty
 * Embedding-only providers are skipped.
 */
function detectBestLocalProvider(): { provider: string; model: string } {
	const { execSync } = require("node:child_process");

	function fetchChatModels(url: string, extract: (data: any) => string[]): string[] {
		try {
			const raw = execSync(`curl -s --max-time 2 "${url}"`, {
				timeout: 3000,
			}).toString();
			const data = JSON.parse(raw);
			const all = extract(data)
				.map((s: string) => s.trim())
				.filter(Boolean);
			return all.filter((id: string) => !isLikelyEmbeddingModelId(id));
		} catch {
			return [];
		}
	}

	// 1. LM Studio
	const lmModels = fetchChatModels("http://localhost:1234/v1/models", (d) =>
		(d.data || []).map((m: any) => String(m.id ?? "")),
	);
	if (lmModels.length > 0) {
		return { provider: "lmstudio", model: pickBestChatModel(lmModels) };
	}

	// 2. Ollama
	const ollamaModels = fetchChatModels("http://localhost:11434/api/tags", (d) =>
		(d.models || []).map((m: any) => String(m.name ?? "")),
	);
	if (ollamaModels.length > 0) {
		return { provider: "ollama", model: pickBestChatModel(ollamaModels) };
	}

	// 3. Apfel (Apple Intelligence — macOS 26+, Apple Silicon only)
	// Run with: apfel --serve --port 11435
	const isAppleSilicon = process.arch === "arm64" && process.platform === "darwin";
	if (isAppleSilicon) {
		const apfelModels = fetchChatModels("http://localhost:11435/v1/models", (d) =>
			(d.data || []).map((m: any) => String(m.id ?? "")),
		);
		if (apfelModels.length > 0) {
			return { provider: "apfel", model: pickBestChatModel(apfelModels) };
		}
	}

	return { provider: "ollama", model: "" };
}

loadEnvFile();
const _savedProviderSettings = loadProviderSettings();
// If no saved provider/model, auto-detect the best available local provider
if (!_savedProviderSettings.model) {
	const detected = detectBestLocalProvider();
	if (detected.model) {
		_savedProviderSettings.provider = detected.provider;
		_savedProviderSettings.model = detected.model;
	}
}

/** Merge saved ~/.8gent/providers.json with optional CLI --provider / --model. */
function computeCliOverrides(
	cliProvider?: string,
	cliModel?: string,
): { provider: string; model: string } {
	const norm = normalizeProviderId(cliProvider);
	const savedP = _savedProviderSettings.provider;
	const savedM = _savedProviderSettings.model;
	const provider = norm ?? savedP;
	const cliModelTrim = cliModel?.trim() ?? "";
	const providerSwitchedByCli = !!norm && norm !== savedP;
	let model = "";
	if (cliModelTrim) model = cliModelTrim;
	else if (providerSwitchedByCli) model = "";
	else model = savedM;
	if (!model) {
		const d = detectBestLocalProvider();
		model = d.model;
	}
	return { provider, model };
}

// Import onboarding system
import { OnboardingManager } from "../../../packages/self-autonomy/index.js";

// ----------------------------------------------------------------------------
// TTS helper — speak agent replies via macOS `say` when voice.outputEnabled.
// Picks the per-agent voice from settings (Daniel / Karen / Moira by default)
// and falls back to voice.ttsVoice. Fully fire-and-forget so TUI never blocks
// on audio. macOS-only; silently no-ops on other platforms.
// ----------------------------------------------------------------------------
function speakAgentReply(role: string | undefined, text: string): void {
	if (process.platform !== "darwin") return;
	const trimmed = (text ?? "").trim();
	if (!trimmed) return;
	let s: ReturnType<typeof loadAppSettings>;
	try {
		s = loadAppSettings();
	} catch {
		return;
	}
	if (!s.voice?.outputEnabled) return;
	const voice = getVoiceForRole(role || "engineer", s);
	// Cap utterance length so we don't tie up `say` on long answers.
	// macOS `say` handles long text fine, but anything past ~600 chars is
	// just noise for the user.
	const safe = trimmed.replace(/"/g, '\\"').slice(0, 600);
	try {
		const { spawn } = require("node:child_process");
		const proc = spawn("say", ["-v", voice, safe], {
			stdio: "ignore",
			detached: true,
		});
		proc.on("error", () => {
			// Voice unavailable on this machine. Stay silent.
		});
		proc.unref();
	} catch {
		// Spawn failed (no shell, restricted env). Fail silently.
	}
}

// ----------------------------------------------------------------------------
// Onboarding TTS helper. Speaks ONLY the first sentence/line of an onboarding
// prompt so the auto-detect block + tagline body don't get read aloud. Gated
// by voice.outputEnabled so users who turn TTS off don't hear startup banter.
//
// Soft modulation:
// - rate 150 wpm via `-r 150` (macOS `say` default ~180 wpm). Calmer pace
//   than chat replies, less corporate cadence.
// - `[[pbas 35]]` speech-command tag drops the pitch base from default 50 to
//   35, giving the line a gentler, more inviting feel. The `[[rset 0]]` tag
//   resets any prior modulation state on the same `say` voice so this stays
//   consistent across calls.
// - Both modulations apply ONLY to onboarding. Normal chat replies use the
//   speakLine helper (above) at default rate/pitch.
// ----------------------------------------------------------------------------
function speakOnboardingLine(rawText: string, voiceOverride?: string | null): void {
	if (process.platform !== "darwin") return;
	// Skip TTS entirely in non-TTY/CI so the smoke harness and piped
	// invocations don't fork off background `say` processes.
	if (!process.stdout.isTTY) return;
	if (process.env.CI) return;
	const trimmed = (rawText ?? "").trim();
	if (!trimmed) return;
	let s: ReturnType<typeof loadAppSettings>;
	try {
		s = loadAppSettings();
	} catch {
		return;
	}
	if (!s.voice?.outputEnabled) return;
	// First non-empty line only. Splitting on a real newline (not the literal
	// "\n" string) keeps multi-paragraph prompts (auto-detect summary, voice
	// pick descriptions) from being read aloud whole.
	const firstLine =
		trimmed
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? trimmed;
	// Strip quotes (would terminate the shell argument) and inline `[[ ]]`
	// tags from raw text so users can't accidentally inject speech commands.
	const safe = firstLine
		.replace(/"/g, "")
		.replace(/\[\[[^\]]*\]\]/g, "")
		.slice(0, 120);
	const voice = (voiceOverride && voiceOverride.trim()) || "Moira";
	// `[[rset 0]]` resets the voice state, then `[[pbas 35]]` lowers the
	// pitch base for a softer delivery. Tags are inline speech commands; see
	// `man say` (Speech Synthesis Manager).
	const softText = `[[rset 0]] [[pbas 35]] ${safe}`;
	try {
		const { spawn } = require("node:child_process");
		const proc = spawn("say", ["-r", "150", "-v", voice, softText], {
			stdio: "ignore",
			detached: true,
		});
		proc.on("error", () => {});
		proc.unref();
	} catch {
		// Fail silently
	}
}

// Import design agent
import {
	DesignAgent,
	type DesignSuggestion,
	createDesignAgent,
} from "../../../packages/design-agent/index.js";
import { DesignSuggestionPanel } from "./components/design-selector.js";

// ============================================
// Types
// ============================================

interface AppProps {
	initialCommand: string;
	args: string[];
	sessionName?: string;
	sessionResume?: string;
	cliProvider?: string;
	cliModel?: string;
	/** Non-interactive: skip onboarding when --yes / -y */
	cliAutoApprove?: boolean;
}

export interface Message {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: Date;
	/** For tool messages: whether the tool succeeded */
	toolSuccess?: boolean;
}

type ProcessingStage = "planning" | "toolshed" | "executing" | "complete";
type AgentMode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";
const AGENT_MODES: AgentMode[] = [
	"Planning",
	"Researching",
	"Implementing",
	"Testing",
	"Debugging",
];
type AppStatus = "idle" | "thinking" | "executing" | "success" | "error";
type ViewMode =
	| "chat"
	| "kanban"
	| "avenues"
	| "predict"
	| "model-select"
	| "provider-select"
	| "onboarding"
	| "animations"
	| "design"
	| "history"
	| "music";

// Inline types for planning (to avoid import issues)
interface ProactiveStep {
	id: string;
	description: string;
	tool: string;
	input: Record<string, unknown>;
	priority: number;
	confidence: number;
	category: string;
	predictedAt: Date;
	basedOn: string[];
}

interface KanbanBoard {
	backlog: ProactiveStep[];
	ready: ProactiveStep[];
	inProgress: ProactiveStep[];
	done: ProactiveStep[];
}

interface Avenue {
	id: string;
	name: string;
	description: string;
	probability: number;
	category: string;
	triggers: string[];
	plan: {
		goal: string;
		steps: Array<{
			id: string;
			description: string;
			tool: string;
		}>;
		estimatedTime: number;
	};
}

// ============================================
// Settings -> environment migration
// ============================================
//
// Applies persisted settings from ~/.8gent/settings.json to the process
// environment exactly once, BEFORE any subsystem (agent, providers, IntroBanner)
// reads its env vars. Existing env vars take precedence over settings only
// for the performance.mode = "auto" case; explicit "lite" / "full" / "on" /
// "off" values always override env vars.
//
// Provider baseURLs only set the env var when settings hold a non-empty value
// AND the env var isn't already present, so users can still override per-shell.
//
// This runs once at module import time.
function applySettingsToEnv(): void {
	try {
		const s = loadAppSettings();
		// Performance mode
		if (s.performance.mode === "lite") {
			process.env["8GENT_LITE"] = "1";
			delete process.env["8GENT_FULL"];
		} else if (s.performance.mode === "full") {
			process.env["8GENT_FULL"] = "1";
			process.env["8GENT_LITE"] = "0";
		}
		// Intro banner: explicit on/off overrides env vars
		if (s.performance.introBanner === "off") {
			process.env["8GENT_NO_INTRO"] = "1";
		} else if (s.performance.introBanner === "on") {
			delete process.env["8GENT_NO_INTRO"];
		}
		// Provider baseURLs - only set when env var is not already present
		const setIfMissing = (key: string, value: string) => {
			if (value && !process.env[key]) process.env[key] = value;
		};
		setIfMissing("APFEL_BASE_URL", s.providers.apfel.baseURL);
		setIfMissing("OLLAMA_BASE_URL", s.providers.ollama.baseURL);
		setIfMissing("LMSTUDIO_BASE_URL", s.providers.lmstudio.baseURL);
		setIfMissing("OPENROUTER_BASE_URL", s.providers.openrouter.baseURL);
	} catch {
		// Best-effort: if settings are unreadable, fall through to existing defaults
	}
}
applySettingsToEnv();

// ============================================
// Main App
// ============================================

export function App({
	initialCommand,
	args,
	sessionName,
	sessionResume,
	cliProvider,
	cliModel,
	cliAutoApprove,
}: AppProps) {
	const { exit } = useApp();

	// Personality greetings (inline for independence)
	const GREETINGS = [
		"Good day. What shall we build?",
		"Ah, a new task. Excellent.",
		"Ready to craft something magnificent?",
		"At your service. What's the mission?",
		"\u221E The infinite gentleman awaits.",
		"Splendid to see you. Where shall we begin?",
	];
	const randomGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];

	// Core state
	// Per-tab message storage (tab-aware logic wired after workspaceTabs hook below)
	const tabMessagesRef = useRef<Map<string, Message[]>>(new Map());
	const [messages, setMessagesRaw] = useState<Message[]>([
		{
			id: "welcome",
			role: "system",
			content: `\u221E 8gent Code \u2014 The Infinite Gentleman\n\n${randomGreeting}\n/help for commands, Tab for suggestions, or just ask.`,
			timestamp: new Date(),
		},
	]);
	// Per-tab processing state lives in usePerTabAgents below. We still keep a
	// stable derived `isProcessing` for the *active* tab so the rest of the UI
	// (header, input gating, status verb) reads from a single boolean. A second
	// helper `isTabProcessing(tabId)` is passed to TabBar for the inline busy
	// indicator on background tabs.
	// (perTabAgents declared after workspaceTabs so it can react to the active
	//  tab id; processing helpers are then assigned to module-level closures.)

	// Background task pool (Ctrl+G to background current, Ctrl+J to open panel)
	const [bgPanelOpen, setBgPanelOpen] = useState(false);
	const [bgTasks, setBgTasks] = useState<bgPool.BgTask[]>(() => bgPool.list());
	const [bgBanner, setBgBanner] = useState<string | null>(null);
	const [bgRunning, setBgRunning] = useState(0);
	const [providerHealth, setProviderHealth] = useState<{ live: number; total: number }>({
		live: 0,
		total: 1,
	});
	// One-shot intro banner shown for ~1.5s on launch, dismissable on any key.
	// Skipped entirely if the user opts out (8GENT_NO_INTRO=1 or 8GENT_LITE=1).
	// Lite mode in v0.11.1+ also disables auxiliary subsystems for jcode-style
	// fast launch when the user prefers speed over polish.
	// Persisted preference at performance.introBanner overrides env var detection
	// when set to "on" or "off". "auto" falls back to env var logic.
	const [introVisible, setIntroVisible] = useState(() => {
		try {
			const s = loadAppSettings();
			if (s?.performance?.introBanner === "off") return false;
			if (s?.performance?.introBanner === "on") return true;
		} catch {
			// Fall through to env var detection
		}
		return process.env["8GENT_NO_INTRO"] !== "1" && process.env["8GENT_LITE"] !== "1";
	});
	// Legacy foreground refs migrated into perTabAgents.{trackPromise,
	// getPromise, getLabel, clearPromise} - see Ctrl+G handler. Kept these
	// names removed to make accidental cross-tab leaks compile-fail.

	const [processingStage, setProcessingStage] = useState<ProcessingStage>("planning");
	const [status, setStatus] = useState<AppStatus>("idle");

	// Real-time agent progress (replaces fake simulateProcessing)
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const [stepCount, setStepCount] = useState(0);
	const [toolCount, setToolCount] = useState(0);
	const [totalTokens, setTotalTokens] = useState(0);
	// tokensSaved removed — using real totalTokens from agent events
	const [startTime] = useState(new Date());
	const [recentCommands, setRecentCommands] = useState<string[]>([]);

	// Auth state (non-blocking)
	const [authStatus, setAuthStatus] = useState<"unknown" | "anonymous" | "authenticated" | "error">(
		"unknown",
	);
	const [authUser, setAuthUser] = useState<{
		displayName: string;
		plan: string;
	} | null>(null);
	const [projectCwd, setProjectCwd] = useState(() => process.cwd());

	// Voice input — transcript goes to input field for review, NOT auto-send
	const [voiceTranscript, setVoiceTranscript] = useState<string | null>(null);
	const voice = useVoiceInput({
		onTranscript: (text) => {
			setVoiceTranscript(text);
			addSystemMessage(`Transcribed: "${text}" — edit or press Enter to send`);
		},
	});

	// Voice chat — adds messages to screen AND calls agent directly
	const voiceChat = useVoiceChat({
		onAgentMessage: async (transcript) => {
			if (!agent || !agentReady) return "Agent not ready.";
			const clean = transcript
				.replace(/\[_EOT_\]/g, "")
				.replace(/<\|.*?\|>/g, "")
				.trim();
			if (!clean) return "";

			// Show the user's voice message on screen
			setMessages((prev) => [
				...prev,
				{
					id: `voice-user-${Date.now()}`,
					role: "user" as const,
					content: `🎤 ${clean}`,
					timestamp: new Date(),
				},
			]);

			try {
				// Run D critic loop: Gemma 4 generates, qwen3:32b critiques, one retry if rejected
				let response = await agent.chat(clean);
				const { approved, feedback } = await critiqueResponse(clean, response || "");
				if (!approved && feedback) {
					response = await agent.chat(
						`${clean}\n\n[Your previous response was critiqued: ${feedback}. Please address the flaws and try again.]`,
					);
				}
				const cleanResponse = (response || "")
					.replace(/\[_EOT_\]/g, "")
					.replace(/<\|.*?\|>/g, "")
					.trim();
				// Show the agent's response on screen
				if (cleanResponse) {
					setMessages((prev) => [
						...prev,
						{
							id: `voice-agent-${Date.now()}`,
							role: "assistant" as const,
							content: cleanResponse,
							timestamp: new Date(),
						},
					]);
				}
				return cleanResponse || "Done.";
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return `Error: ${msg}`;
			}
		},
		voice: "Daniel",
		silenceMs: 1500,
		onActiveChange: (active) => {
			if (active) {
				addSystemMessage(
					"🎙️ Voice chat active. Speak naturally. ESC to stop, ESC during speech to interrupt.",
				);
			} else {
				addSystemMessage("Voice chat ended.");
			}
		},
	});

	// Wire the agent's token stream to the Thinking-box visualiser so live
	// LLM tokens perturb the param vector. Sink registers once on mount,
	// detaches on unmount. The bridge (packages/eight/visualiser-bridge.ts)
	// is a no-op when no sink is registered, so harness/CLI modes are
	// unaffected.
	useEffect(() => {
		setVisualiserTokenSink(pushVisualiserToken);
		return () => {
			setVisualiserTokenSink(null);
		};
	}, []);

	// Initialize auth on mount (fire-and-forget, never blocks)
	useEffect(() => {
		initAuthSystem()
			.then((state) => {
				setAuthStatus(state.state === "authenticated" ? "authenticated" : "anonymous");
				if (state.state === "authenticated") {
					setAuthUser({
						displayName: state.user.displayName || "User",
						plan: state.user.plan,
					});
				}
			})
			.catch(() => setAuthStatus("anonymous"));
	}, []);

	// Named session management
	const sessionMgr = React.useMemo(() => new SessionManager(), []);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

	// Initialize session logger on mount
	useEffect(() => {
		const sessionId = `session-${Date.now()}`;
		initSessionLogger(sessionId, currentModel, currentProvider);

		// Resume existing session or create a new one
		if (sessionResume) {
			const resumed = sessionMgr.resume(sessionResume);
			if (resumed) {
				setActiveSessionId(resumed.id);
				if (resumed.messages.length > 0) {
					const restored = resumed.messages.map((m, i) => ({
						id: `restored-${i}`,
						role: m.role as "user" | "assistant" | "system",
						content: m.content,
						timestamp: new Date(),
					}));
					setMessages(restored as Message[]);
				}
				addSystemMessage(
					`Resumed session: "${resumed.name || resumed.id}" (${resumed.messageCount} messages)`,
				);
			} else {
				addSystemMessage(`Session "${sessionResume}" not found.`);
			}
		} else {
			const created = sessionMgr.create({
				name: sessionName,
				model: currentModel,
				provider: currentProvider,
			});
			setActiveSessionId(created.id);
			if (sessionName) {
				addSystemMessage(`Session named: "${sessionName}"`);
			}
		}

		return () => {
			flushSession();
		};
	}, []);

	// Animation settings
	const [showAnimations, setShowAnimations] = useState(true);
	const [soundEnabled, setSoundEnabled] = useState(false);
	const [fancyHeader, setFancyHeader] = useState(false);
	const [showEnhancedStatus, setShowEnhancedStatus] = useState(true);
	// Performance metrics
	const [lastResponseTime, setLastResponseTime] = useState<number | undefined>();
	const [contextSize, setContextSize] = useState<number | undefined>();

	// Context window tracking
	const [contextUsed, setContextUsed] = useState(0);
	const [contextMax] = useState(128000); // Default max context window

	// Expanded view state (Ctrl+O)
	const [expandedView, setExpandedView] = useState(false);

	// Git state (would be populated from actual git commands)
	const [isGitRepo] = useState(true);
	const [currentBranch] = useState<string | null>("main");

	// Session branching tree
	const sessionTreeRef = useRef(new SessionTree());

	// Planning state (legacy predicted-step board)
	const [kanbanBoard, setKanbanBoard] = useState<KanbanBoard>({
		backlog: [],
		ready: [],
		inProgress: [],
		done: [],
	});

	// Auto-populating kanban from real agent events
	const autoKanban = useAutoKanban();
	const [avenues, setAvenues] = useState<Avenue[]>([]);
	const [predictedSteps, setPredictedSteps] = useState<ProactiveStep[]>([]);
	const [planNextStep, setPlanNextStep] = useState<string | null>(null);

	// View state — now driven by workspace tabs
	const [viewMode, setViewMode] = useState<ViewMode>("chat");

	// Workspace tabs
	const workspaceTabs = useWorkspaceTabs();
	const activeTabType = workspaceTabs.activeTab?.type || "chat";
	const activeTabId = workspaceTabs.activeTab?.id || "default";

	// Per-tab agents (one Agent + processing flag per chat tab). This is the
	// core of "feat/per-tab-concurrent": each chat tab can hold its own
	// in-flight agent.chat() call simultaneously. The active tab still drives
	// the foreground UI; other tabs' work continues in the background and
	// shows up in tabMessagesRef when their chat() resolves.
	const perTabAgents = usePerTabAgents();
	const isProcessing = perTabAgents.isTabProcessing(activeTabId);
	const setIsProcessing = useCallback(
		(val: boolean) => {
			perTabAgents.setTabProcessing(activeTabId, val);
		},
		[activeTabId, perTabAgents.setTabProcessing],
	);

	// Background pool subscription: snapshot tasks + surface non-modal banner on settle
	useEffect(() => {
		const unsub = bgPool.onChange((task) => {
			setBgTasks(bgPool.list());
			setBgRunning(bgPool.runningCount());
			if (task.status === "done" || task.status === "error") {
				setBgBanner(
					task.status === "done"
						? `Background task complete: ${task.label}. Ctrl+J to review.`
						: `Background task failed: ${task.label}. Ctrl+J to review.`,
				);
			}
		});
		return () => {
			unsub();
		};
	}, []);

	// Per-tab message sync: save current tab's messages, load new tab's messages on switch
	const prevTabIdRef = useRef(activeTabId);
	useEffect(() => {
		if (prevTabIdRef.current !== activeTabId) {
			// Log tab switch for session debugger
			logTabSwitch(prevTabIdRef.current, activeTabId, workspaceTabs.activeTab?.title || "Chat");

			// Save outgoing tab's messages
			setMessagesRaw((currentMsgs) => {
				tabMessagesRef.current.set(prevTabIdRef.current, currentMsgs);
				return currentMsgs;
			});
			// Load incoming tab's messages (or create fresh welcome)
			const incoming = tabMessagesRef.current.get(activeTabId);
			if (incoming) {
				setMessagesRaw(incoming);
			} else {
				const fresh: Message[] = [
					{
						id: `welcome-${activeTabId}`,
						role: "system",
						content:
							"\u221E 8gent Code \u2014 The Infinite Gentleman\n\nNew thread. What shall we work on?",
						timestamp: new Date(),
					},
				];
				tabMessagesRef.current.set(activeTabId, fresh);
				setMessagesRaw(fresh);
			}
			prevTabIdRef.current = activeTabId;
		}
	}, [activeTabId]);

	// Per-tab model: when the active tab is a chat tab tied to a role, swap the
	// currentProvider/currentModel to whatever the role registry says. Each
	// agent tab (Orchestrator / Engineer / QA) gets its own backing inference
	// engine - one model per agent.
	useEffect(() => {
		const tab = workspaceTabs.activeTab;
		if (!tab || tab.type !== "chat") return;
		const role = (tab.data as { role?: string } | undefined)?.role;
		if (!role) return;
		const cfg = ROLE_REGISTRY[role];
		// Persisted settings override role-registry defaults for orchestrator/engineer/qa tabs.
		try {
			const s = loadAppSettings();
			const tabsMap = s.models?.tabs as unknown as Record<
				string,
				{ provider: string; model: string }
			>;
			const tabSettings = tabsMap?.[role];
			if (tabSettings?.provider && tabSettings?.model) {
				setCurrentProvider(tabSettings.provider);
				setCurrentModel(tabSettings.model);
				return;
			}
		} catch {
			// Fall through to role-registry default
		}
		if (!cfg?.inferenceMode || !cfg?.model) return;
		setCurrentProvider(cfg.inferenceMode);
		setCurrentModel(cfg.model);
	}, [activeTabId]);

	// Provider health probe: count how many of the 3 local inference engines
	// (Apple Foundation, LM Studio, Ollama) are currently up. Drives the
	// status bar `X/Y agents` slot - reflects "all three inferences live".
	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			try {
				const { live, total } = await probeProviders();
				if (!cancelled) setProviderHealth({ live, total });
			} catch {
				// best-effort - status bar can stay stale rather than crash
			}
		};
		tick();
		const id = setInterval(tick, 8000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	// setMessages wrapper that also updates the ref map for current tab
	const setMessages: React.Dispatch<React.SetStateAction<Message[]>> = useCallback(
		(action) => {
			setMessagesRaw((prev) => {
				const next = typeof action === "function" ? action(prev) : action;
				tabMessagesRef.current.set(activeTabId, next);
				return next;
			});
		},
		[activeTabId],
	);

	// Infinite mode state (must match packages/permissions, including CLI --infinite)
	const [infiniteModeActive, setInfiniteModeActive] = useState(() => isInfiniteMode());

	// Model/Provider state (must be before agent init)
	const cliModelRequestedRef = useRef((cliModel ?? "").trim());
	const [currentProvider, setCurrentProvider] = useState(
		() => computeCliOverrides(cliProvider, cliModel).provider,
	);
	const [currentModel, setCurrentModel] = useState(
		() => computeCliOverrides(cliProvider, cliModel).model,
	);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);

	// Auto-save session every 30 seconds when messages change
	const lastSaveCount = useRef(0);
	useEffect(() => {
		if (!activeSessionId) return;
		const timer = setInterval(() => {
			if (messages.length > lastSaveCount.current) {
				lastSaveCount.current = messages.length;
				const serializable = messages.map((m) => ({
					role: m.role,
					content: m.content,
				}));
				sessionMgr.update(activeSessionId, serializable, {
					model: currentModel,
					provider: currentProvider,
				});
			}
		}, 30_000);
		return () => clearInterval(timer);
	}, [activeSessionId, messages, currentModel, currentProvider]);

	// Fetch models dynamically based on selected provider
	useEffect(() => {
		let cancelled = false;
		const fetchModels = async () => {
			setModelsLoading(true);
			try {
				if (currentProvider === "ollama") {
					// Fetch locally installed Ollama models — filter embedding models at source
					const res = await fetch("http://localhost:11434/api/tags");
					if (res.ok) {
						const data = await res.json();
						const allModels = (data.models || [])
							.map((m: any) => String(m.name ?? "").trim())
							.filter((id: string) => id.length > 0);
						const chatModels = allModels.filter((id: string) => !isLikelyEmbeddingModelId(id));
						if (!cancelled) setAvailableModels(chatModels.length > 0 ? chatModels : allModels);
					}
				} else if (currentProvider === "lmstudio") {
					// Fetch LM Studio models — filter embedding models at source so they
					// never pollute the model list or get auto-selected as chat models
					const res = await fetch("http://localhost:1234/v1/models");
					if (res.ok) {
						const data = await res.json();
						const allModels = (data.data || [])
							.map((m: any) => String(m.id ?? "").trim())
							.filter((id: string) => id.length > 0);
						const chatModels = allModels.filter((id: string) => !isLikelyEmbeddingModelId(id));
						if (!cancelled) setAvailableModels(chatModels.length > 0 ? chatModels : allModels);
					}
				} else if (currentProvider === "openrouter-free") {
					// Fetch free models from OpenRouter API
					const apiKey = process.env.OPENROUTER_API_KEY || "";
					const res = await fetch("https://openrouter.ai/api/v1/models", {
						headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					});
					if (res.ok) {
						const data = await res.json();
						const freeModels = (data.data || [])
							.filter((m: any) => m.id?.endsWith(":free"))
							.map((m: any) => m.id as string)
							.sort();
						if (!cancelled)
							setAvailableModels(
								freeModels.length > 0 ? freeModels : ["google/gemini-2.5-flash:free"],
							);
					}
				} else if (currentProvider === "openrouter") {
					// Fetch all OpenRouter models (top 20 by context length)
					const apiKey = process.env.OPENROUTER_API_KEY || "";
					const res = await fetch("https://openrouter.ai/api/v1/models", {
						headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					});
					if (res.ok) {
						const data = await res.json();
						const models = (data.data || [])
							.filter((m: any) => !m.id?.endsWith(":free"))
							.map((m: any) => m.id as string)
							.slice(0, 30);
						if (!cancelled) setAvailableModels(models);
					}
				} else if (currentProvider === "apfel") {
					// apfel exposes Apple Foundation as an OpenAI-compatible HTTP server.
					// Default port 11500 (override via APFEL_BASE_URL).
					const baseUrl = process.env.APFEL_BASE_URL || "http://localhost:11500/v1";
					const res = await fetch(`${baseUrl}/models`);
					if (res.ok) {
						const data = await res.json();
						const allModels = (data.data || [])
							.map((m: any) => String(m.id ?? "").trim())
							.filter((id: string) => id.length > 0);
						const chatModels = allModels.filter((id: string) => !isLikelyEmbeddingModelId(id));
						if (!cancelled) setAvailableModels(chatModels.length > 0 ? chatModels : allModels);
					} else if (!cancelled) {
						setAvailableModels(["apple-foundationmodel"]);
					}
				} else {
					// Other providers — show placeholder
					if (!cancelled) setAvailableModels([`${currentProvider}/default`]);
				}
			} catch {
				// Provider not reachable — show fallback
				if (!cancelled) setAvailableModels([]);
			}
			if (!cancelled) setModelsLoading(false);
		};
		fetchModels();
		return () => {
			cancelled = true;
		};
	}, [currentProvider]);

	// After model list loads: ensure currentModel is valid for the active provider.
	// If the model isn't in the fetched list (e.g. Ollama model on OpenRouter), auto-select.
	useEffect(() => {
		if (modelsLoading || availableModels.length === 0) return;

		const inList = Boolean(currentModel && availableModels.includes(currentModel));
		const bad = !currentModel || !inList || isLikelyEmbeddingModelId(currentModel);

		if (!bad) return;

		const next = pickBestChatModel(availableModels, {
			preference: cliModelRequestedRef.current || undefined,
		});
		if (next && next !== currentModel) {
			setCurrentModel(next);
		}
	}, [modelsLoading, availableModels, currentProvider, currentModel]);

	// If models have loaded and there's still no valid chat model, show provider selector
	// so the user can pick a provider / download a model without the app crashing.
	useEffect(() => {
		if (modelsLoading) return;
		if (currentModel && !isLikelyEmbeddingModelId(currentModel)) return;
		if (availableModels.some((m) => !isLikelyEmbeddingModelId(m))) return;
		// No chat model anywhere — guide user to provider setup
		if (viewMode === "chat") setViewMode("provider-select");
	}, [modelsLoading, availableModels, currentModel, viewMode]);

	const [availableProviders] = useState<ProviderOption[]>([
		{
			name: "ollama",
			displayName: "Ollama (Local) - Free",
			hasApiKey: true,
			enabled: true,
		},
		{
			name: "lmstudio",
			displayName: "LM Studio (Local) - Free",
			hasApiKey: true,
			enabled: true,
		},
		{
			name: "openrouter-free",
			displayName: "OpenRouter (Free Models) 🆓",
			hasApiKey: true,
			enabled: true,
		},
		{
			name: "openrouter",
			displayName: "OpenRouter (Paid Models)",
			hasApiKey: false,
			enabled: true,
		},
		{
			name: "groq",
			displayName: "Groq (Free Tier)",
			hasApiKey: false,
			enabled: true,
		},
		{ name: "openai", displayName: "OpenAI", hasApiKey: false, enabled: true },
		{
			name: "anthropic",
			displayName: "Anthropic",
			hasApiKey: false,
			enabled: true,
		},
		{
			name: "mistral",
			displayName: "Mistral AI",
			hasApiKey: false,
			enabled: true,
		},
	]);

	// Active-tab Agent instance for real execution. Per-tab agents live in
	// perTabAgents.agentsRef; this state mirrors the agent for the currently
	// focused tab so voice-chat / ESC / status reads stay tab-correct.
	const [agent, setAgent] = useState<Agent | null>(null);
	const [agentReady, setAgentReady] = useState(false);

	// Evidence tracking (real-time display)
	const [evidenceSummary, setEvidenceSummary] = useState<AgentEvidenceSummaryEvent | null>(null);

	// Check for updates on launch (non-blocking)
	const updateInfo = useUpdateCheck();

	// TV Mode state — task cards + narrator
	const viewport = useViewport();
	const [tvTasks, setTvTasks] = useState<TaskItem[]>([]);
	const [narratorText, setNarratorText] = useState("");

	// Image attachment (paste image paths or drag-drop)
	const imageInput = useImageInput();

	const transformChatInput = useCallback(
		(v: string) => consumeIfWholeValueIsImagePath(v, imageInput.attachImage),
		[imageInput.attachImage],
	);

	// Background process panel
	const processPanel = useProcessPanel();

	const processSidebarWidth = computeProcessSidebarWidth(processPanel.sidebarOpen, viewport.width);
	const chatContentWidth = tuiChatContentWidth(viewport.width, processSidebarWidth);
	const compactAgentModeBar = viewport.width < TUI_AGENT_MODE_COMPACT_BELOW;
	const tokenMeterColWidth = viewport.width < 52 ? 6 : viewport.width < 72 ? 9 : 12;

	// Per-tab message queue — each tab has its own pending-submission queue so
	// typing on tab A while tab A's agent is busy stacks A's queue without
	// affecting tab B's parallel submissions.
	const messageQueuesRef = useRef<Map<string, string[]>>(new Map());
	// Per-tab "agent currently running" guard. Replaces the legacy global
	// boolean - now keyed by tab id so concurrent tabs no longer block each
	// other on the same flag.
	const agentRunningTabsRef = useRef<Set<string>>(new Set());
	const isAgentRunningOnTab = (tabId: string) => agentRunningTabsRef.current.has(tabId);
	const setAgentRunningOnTab = (tabId: string, val: boolean) => {
		if (val) agentRunningTabsRef.current.add(tabId);
		else agentRunningTabsRef.current.delete(tabId);
	};

	// Multi-agent orchestration
	const orchestration = useAgentOrchestration();

	// Onboarding system
	const [onboardingManager] = useState(() => new OnboardingManager(process.cwd()));
	const [showOnboarding, setShowOnboarding] = useState(false);
	const [currentOnboardingQuestion, setCurrentOnboardingQuestion] = useState<string | null>(null);
	const [onboardingSteps, setOnboardingSteps] = useState<
		Array<{
			question: string;
			answer?: string;
			status: "pending" | "active" | "done";
		}>
	>([]);
	const [onboardingStepIndex, setOnboardingStepIndex] = useState(0);
	// Choices for the active onboarding question when kind === "select".
	// null = current question is free-text (CommandInput owns input).
	const [onboardingSelectChoices, setOnboardingSelectChoices] = useState<
		Array<{ label: string; value: string; description?: string }> | null
	>(null);
	// kind === "providerCheck" payload: which engine to probe + install hint.
	// The OnboardingScreen probes once on entry, shows status, and emits
	// "live" or "skip" via onProviderResolve which we route into processAnswer.
	const [onboardingProviderCheck, setOnboardingProviderCheck] = useState<
		{ provider: "ollama" | "lmstudio" | "apfel"; installHint: string } | null
	>(null);
	// kind === "agentName" payload: default value to show as a hint and accept
	// on empty Enter. The actual input still goes through CommandInput.
	const [onboardingAgentDefault, setOnboardingAgentDefault] = useState<
		string | null
	>(null);
	// Live total step count - set on first onboarding render so the
	// "Step X of N" indicator reflects whatever the question list is.
	const [onboardingTotalSteps, setOnboardingTotalSteps] = useState<number>(0);

	/**
	 * Apply an OnboardingQuestion to local screen state. Centralizes the
	 * "set question text + select choices + providerCheck payload + agentName
	 * default" logic so all four call sites (initial load, /onboarding, /skip,
	 * processAnswer) stay in sync. Without this helper it's easy to miss
	 * resetting one of the new kinds when transitioning between steps.
	 */
	const applyOnboardingQuestion = useCallback(
		(q: {
			question: string;
			kind?: "text" | "select" | "providerCheck" | "agentName";
			choices?: Array<{ label: string; value: string; description?: string }>;
			provider?: "ollama" | "lmstudio" | "apfel";
			installHint?: string;
			default?: string;
		}) => {
			setCurrentOnboardingQuestion(q.question);
			setOnboardingSelectChoices(
				q.kind === "select" && q.choices ? q.choices : null,
			);
			setOnboardingProviderCheck(
				q.kind === "providerCheck" && q.provider
					? { provider: q.provider, installHint: q.installHint ?? "" }
					: null,
			);
			setOnboardingAgentDefault(
				q.kind === "agentName" && typeof q.default === "string" ? q.default : null,
			);
		},
		[],
	);

	// Animation showcase
	const [currentAnimation, setCurrentAnimation] = useState<AnimationType>("all");

	// Agent mode (Tab to cycle)
	const [agentMode, setAgentMode] = useState<AgentMode>("Planning");

	// ADHD/Bionic reading mode
	const [adhdMode, setAdhdMode] = useState(false);
	const [adhdSuggested, setAdhdSuggested] = useState(false);

	// Design agent state
	const [designAgent] = useState(() => createDesignAgent({ workingDirectory: process.cwd() }));
	const [designSuggestions, setDesignSuggestions] = useState<DesignSuggestion[]>([]);
	const [designIntro, setDesignIntro] = useState<string>("");
	const [selectedDesign, setSelectedDesign] = useState<DesignSuggestion | null>(null);

	// Handle keyboard shortcuts
	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (soundEnabled) playSound("notification");
			// Save session and finalize before exiting
			if (activeSessionId && messages.length > 0) {
				const serializable = messages.map((m) => ({
					role: m.role,
					content: m.content,
				}));
				sessionMgr.update(activeSessionId, serializable, {
					model: currentModel,
					provider: currentProvider,
				});
			}
			flushSession();
			if (agent) agent.cleanup().catch(() => {});
			exit();
		}

		// Toggle animations with Ctrl+A
		if (key.ctrl && input === "a") {
			setShowAnimations((prev) => !prev);
		}

		// Toggle sound with Ctrl+S
		if (key.ctrl && input === "s") {
			setSoundEnabled((prev) => {
				const next = !prev;
				soundManager.setEnabled(next);
				if (next) playSound("success");
				return next;
			});
		}

		// Toggle fancy header with Ctrl+H
		if (key.ctrl && input === "h") {
			setFancyHeader((prev) => !prev);
		}

		// Toggle kanban with Ctrl+K (overlay, not a tab)
		if (key.ctrl && input === "k") {
			setViewMode((prev) => (prev === "kanban" ? "chat" : "kanban"));
		}

		// Toggle predict with Ctrl+P
		if (key.ctrl && input === "p") {
			setViewMode((prev) => (prev === "predict" ? "chat" : "predict"));
		}

		// Toggle expanded view with Ctrl+O (familiar zoom shortcut from peer terminal agents)
		if (key.ctrl && input === "o") {
			setExpandedView((prev) => !prev);
		}

		// Toggle process panel
		if (key.ctrl && input === "b") {
			processPanel.toggleSidebar();
		}

		// Ctrl+G: background the current foreground task (send to pool).
		// The agent.chat() Promise keeps running; we detach the UI for the
		// active tab. Other tabs' parallel runs are unaffected.
		if (key.ctrl && input === "g") {
			const promise = perTabAgents.getPromise(activeTabId);
			if (promise && isProcessing) {
				const label = perTabAgents.getLabel(activeTabId) || "background task";
				bgPool.track(label, promise);
				perTabAgents.clearPromise(activeTabId);
				addSystemMessage(
					`Sent to background: "${label}". Ctrl+J to review. Starting fresh foreground.`,
				);
				setIsProcessing(false);
				setActiveTool(null);
				setAgentRunningOnTab(activeTabId, false);
				setStatus("idle");
			} else {
				addSystemMessage("No foreground task running to background.");
			}
		}

		// Ctrl+J: toggle background jobs panel. Dismiss banner on open.
		if (key.ctrl && input === "j") {
			setBgPanelOpen((prev) => !prev);
			setBgBanner(null);
		}

		// Ctrl+T: new chat tab
		if (key.ctrl && input === "t") {
			workspaceTabs.addTab("chat");
			setViewMode("chat");
		}

		// Ctrl+W: close current tab. Per-tab Agent is aborted and dropped so
		// closing a tab while it's mid-flight does not leak the chat() loop.
		if (key.ctrl && input === "w") {
			if (workspaceTabs.tabs.length > 1) {
				const closingId = workspaceTabs.activeTab.id;
				perTabAgents.removeTabAgent(closingId);
				setAgentRunningOnTab(closingId, false);
				messageQueuesRef.current.delete(closingId);
				workspaceTabs.removeTab(closingId);
			}
		}

		// Ctrl+1-9: switch to tab by index
		if (key.ctrl && input >= "1" && input <= "9") {
			const idx = Number.parseInt(input, 10) - 1;
			if (idx < workspaceTabs.tabs.length) {
				workspaceTabs.switchToIndex(idx);
				// Only set viewMode for legacy views (kanban, music have their own)
				const tab = workspaceTabs.tabs[idx];
				if (tab?.type === "kanban") setViewMode("kanban");
				else if (tab?.type === "music") setViewMode("music");
				else setViewMode("chat");
			}
		}

		// Shift+Tab: always cycle workspace tabs backward (direction -1)
		// Agent cycling was incorrectly hijacking this — agent focus has no dedicated hotkey yet
		if (key.shift && key.tab) {
			workspaceTabs.cycleTab(-1, ["kanban"]);
			setViewMode("chat");
		}

		// Escape: abort generation if processing, otherwise switch to chat tab or close view.
		// With per-tab agents, ESC aborts ONLY the active tab's loop. Other
		// tabs' in-flight runs keep going.
		if (key.escape) {
			if (isProcessing) {
				perTabAgents.abortTab(activeTabId);
				setIsProcessing(false);
				setActiveTool(null);
				setAgentRunningOnTab(activeTabId, false);
				addSystemMessage("Generation interrupted.");
			} else if (imageInput.currentImage && (viewMode === "chat" || viewMode === "onboarding")) {
				imageInput.removeImage();
			} else if (activeTabType !== "chat" && viewMode === "chat") {
				// In a non-chat tab, escape switches back to first chat tab
				const chatTab = workspaceTabs.tabs.find((t) => t.type === "chat");
				if (chatTab) workspaceTabs.switchTab(chatTab.id);
			} else if (viewMode !== "chat") {
				// If escaping from onboarding, also clear onboarding state
				if (viewMode === "onboarding") {
					setShowOnboarding(false);
					setOnboardingSelectChoices(null);
					setOnboardingProviderCheck(null);
					setOnboardingAgentDefault(null);
					onboardingManager.skipAll();
				}
				setViewMode("chat");
			}
		}
	});

	// Add system message helper
	const addSystemMessage = useCallback((content: string) => {
		setMessages((prev) => [
			...prev,
			{
				id: `system-${Date.now()}`,
				role: "system" as const,
				content,
				timestamp: new Date(),
			},
		]);
	}, []);

	/**
	 * Append a message to a specific tab's history. Always updates
	 * tabMessagesRef so background tabs accumulate output silently. If the
	 * target tab is the active tab, also mirror to the foreground messages
	 * state so the user sees it live. This is the routing seam that makes
	 * concurrent per-tab agent runs not clobber each other.
	 *
	 * For the active tab we use a functional setMessagesRaw update so the
	 * initial welcome message (which lives only in foreground state on first
	 * render) is preserved when the per-tab buffer is still empty.
	 */
	const appendToTab = useCallback(
		(tabId: string, msg: Message) => {
			if (tabId === activeTabId) {
				setMessagesRaw((prev) => {
					const next = [...prev, msg];
					tabMessagesRef.current.set(tabId, next);
					return next;
				});
			} else {
				const cur = tabMessagesRef.current.get(tabId) ?? [];
				const next = [...cur, msg];
				tabMessagesRef.current.set(tabId, next);
			}
		},
		[activeTabId],
	);

	/**
	 * Build the AgentEventCallbacks bound to a specific tab id. Messages
	 * stream into that tab's buffer (visible only when it is active);
	 * narrator / activity-monitor / kanban side-effects are global and only
	 * fire when the event belongs to the active tab so background runs do
	 * not steal foreground attention.
	 */
	const buildEventsForTab = useCallback(
		(tabId: string, tabTitle: string): AgentEventCallbacks => ({
			onToolStart: (event: AgentToolStartEvent) => {
				const isActive = tabId === activeTabId;
				if (isActive) {
					setActiveTool(event.toolName);
					setProcessingStage("executing");
					setStatus("executing");
					pushActivity(event.toolName, event.toolCallId, event.args);
				}
				logToolStart(tabId, tabTitle, event.toolName, event.toolCallId, event.args);

				autoKanban.onTaskStart(tabId, tabTitle, event.toolName, event.toolCallId, event.args);

				if (isActive) {
					setKanbanBoard((prev) => {
						if (prev.inProgress.length === 0 && prev.ready.length > 0) {
							const [next, ...rest] = prev.ready;
							return { ...prev, ready: rest, inProgress: [next] };
						}
						return prev;
					});
					const narration = narrateToolStart(event.toolName, event.args);
					setNarratorText(narration);
					setTvTasks((prev) => [
						...prev.map((t) => (t.status === "active" ? { ...t, status: "done" as const } : t)),
						{
							id: event.toolCallId,
							title: narration,
							status: "active" as const,
						},
					]);
				}

				const argsPreview = JSON.stringify(event.args).slice(0, 80);
				appendToTab(tabId, {
					id: `tool-start-${event.toolCallId}`,
					role: "tool" as const,
					content: `→ ${event.toolName}(${argsPreview})`,
					timestamp: new Date(),
				});
			},
			onToolEnd: (event: AgentToolEndEvent) => {
				const isActive = tabId === activeTabId;
				if (isActive) {
					setToolCount((prev) => prev + 1);
				}
				completeActivity(event.toolCallId, event.success !== false, event.durationMs || 0);
				logToolEnd(
					event.toolCallId,
					event.success !== false,
					event.durationMs || 0,
					event.resultPreview,
				);

				autoKanban.onTaskComplete(
					event.toolCallId,
					event.success !== false,
					event.durationMs || 0,
				);

				const isFailure =
					!event.success ||
					(event.resultPreview?.startsWith("Exit code ") &&
						!event.resultPreview.startsWith("Exit code 0"));

				if (isActive) {
					setNarratorText(narrateToolEnd(event.toolName, !isFailure, event.durationMs));
					setTvTasks((prev) =>
						prev.map((t) =>
							t.id === event.toolCallId
								? {
										...t,
										status: isFailure ? ("error" as const) : ("done" as const),
										duration: event.durationMs,
										details: isFailure ? event.resultPreview?.slice(0, 120) : undefined,
									}
								: t,
						),
					);
					setActiveTool(null);
					setKanbanBoard((prev) => {
						if (prev.inProgress.length > 0) {
							const [completed, ...rest] = prev.inProgress;
							const nextReady = prev.ready.length > 0 ? [prev.ready[0]] : [];
							const remainingReady = prev.ready.slice(nextReady.length > 0 ? 1 : 0);
							const pullFromBacklog =
								remainingReady.length < 2 && prev.backlog.length > 0 ? [prev.backlog[0]] : [];
							const remainingBacklog =
								pullFromBacklog.length > 0 ? prev.backlog.slice(1) : prev.backlog;
							return {
								backlog: remainingBacklog,
								ready: [...remainingReady, ...pullFromBacklog],
								inProgress: [...rest, ...nextReady],
								done: [...prev.done, completed],
							};
						}
						if (prev.ready.length > 0) {
							const [first, ...rest] = prev.ready;
							return { ...prev, ready: rest, done: [...prev.done, first] };
						}
						return prev;
					});
				}

				const isRealFailure =
					!event.success ||
					(event.resultPreview?.startsWith("Exit code ") &&
						!event.resultPreview.startsWith("Exit code 0"));
				const duration =
					event.durationMs > 0 ? ` (${(event.durationMs / 1000).toFixed(1)}s)` : "";
				let content: string;
				if (isRealFailure && event.resultPreview) {
					const errMsg = event.resultPreview.slice(0, 120).split("\n").slice(0, 2).join(" ");
					content = `  ✗ ${errMsg}${duration}`;
				} else {
					content = `  ✓${duration}`;
				}
				appendToTab(tabId, {
					id: `tool-end-${event.toolCallId}`,
					role: "tool" as const,
					content,
					timestamp: new Date(),
					toolSuccess: !isRealFailure,
				});
			},
			onStepFinish: (event: AgentStepEvent) => {
				const isActive = tabId === activeTabId;
				if (isActive) {
					setStepCount((prev) => prev + 1);
					setTotalTokens((prev) => prev + event.usage.totalTokens);
				}
				logStep(tabId, tabTitle, event.stepNumber, event.usage.totalTokens, event.text);

				if (isActive && event.text?.trim()) {
					const planMatch = event.text.match(/PLAN:\s/i);
					if (planMatch) {
						setNarratorText(narratePlan(event.text));
					} else {
						setNarratorText(narrateStep(event.text));
					}
				}

				// Only surface step-0 reasoning text as a system bubble when the
				// step had tool calls — that means the text is intermediate
				// reasoning the model emitted while choosing tools, and we want
				// to show it. When step 0 has NO tool calls, `event.text` IS the
				// final assistant reply; agent.chat() returns it and we render it
				// as the assistant bubble at the chat boundary, so pushing it
				// here would double-render the same content (greyish system bubble
				// followed by the cyan assistant bubble).
				if (
					event.text?.trim() &&
					event.stepNumber === 0 &&
					(event.toolCalls?.length ?? 0) > 0
				) {
					const t = event.text.trim();
					appendToTab(tabId, {
						id: `system-step0-${Date.now()}`,
						role: "system" as const,
						content: t.length > 720 ? `${t.slice(0, 717)}...` : t,
						timestamp: new Date(),
					});
				}

				if (isActive && event.text?.trim()) {
					const planMatch = event.text.match(/PLAN:\s*([\s\S]*?)(?:\n\n|$)/i);
					if (planMatch) {
						const planText = planMatch[1];
						const stepMatches = planText.match(/(?:\d+[.)]\s*|[-•]\s+)([^\n]+)/g);
						if (stepMatches && stepMatches.length > 0) {
							const steps = stepMatches.map((s, i) => ({
								id: `plan-${Date.now()}-${i}`,
								description: s.replace(/^\d+[.)]\s*|^[-•]\s+/, "").trim(),
								tool: "auto",
								input: {},
								priority: stepMatches.length - i,
								confidence: 0.9,
								category: "plan" as const,
								predictedAt: new Date(),
								basedOn: [],
							}));
							setKanbanBoard({
								backlog: steps.slice(3) as any,
								ready: steps.slice(0, 3) as any,
								inProgress: [],
								done: [],
							});
							setPredictedSteps(steps);
							setPlanNextStep(steps[0]?.description || null);
							setProcessingStage("executing");
						}
					}
				}

				if (isActive) {
					const stepToolCalls = event.toolCalls ?? [];
					if (stepToolCalls.length > 0) {
						setProcessingStage("executing");
						setStatus("executing");
					} else {
						setProcessingStage("toolshed");
						setStatus("thinking");
					}
				}
			},
			onEvidence: (event: AgentEvidenceEvent) => {
				const icon = event.verified ? "✓" : "✗";
				const label = event.type.replace(/_/g, " ");
				let desc = event.description;
				if (event.path) {
					const basename = event.path.split("/").pop() || event.path;
					desc = basename;
				} else if (event.command) {
					desc = event.command.slice(0, 40);
				}
				appendToTab(tabId, {
					id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					role: "tool" as const,
					content: `  ${icon} ${label}: ${desc}`,
					timestamp: new Date(),
					toolSuccess: event.verified,
				});
			},
			onEvidenceSummary: (event: AgentEvidenceSummaryEvent) => {
				if (tabId === activeTabId) {
					setEvidenceSummary(event);
				}
				if (event.total > 0) {
					appendToTab(tabId, {
						id: `evidence-summary-${Date.now()}`,
						role: "system" as const,
						content: `[Evidence: ${event.verified}/${event.total} verified]`,
						timestamp: new Date(),
						toolSuccess: event.failed === 0,
					});
				}
			},
		}),
		[activeTabId, appendToTab, autoKanban],
	);

	// Initialize agent for the active tab. Each chat tab owns its own Agent
	// instance; the active-tab agent is mirrored into local `agent`/`agentReady`
	// state so voice-chat / status-bar reads stay tab-correct without
	// re-wiring those subsystems.
	useEffect(() => {
		const initAgent = async () => {
			try {
				// Auto-assign router slots from actually available models
				if (currentProvider === "ollama") {
					const router = getTaskRouter();
					const _changes = await router.autoAssign();
					// If current model is empty, use whatever autoAssign found
					if (!currentModel) {
						const cfg = router.getConfig();
						if (cfg.defaultModel.model) {
							setCurrentModel(cfg.defaultModel.model);
							return; // Will re-trigger this effect with the new model
						}
					}
				}

				const _activeTab = workspaceTabs.activeTab;
				const _initTabId = _activeTab?.id || "default";
				const _initTabTitle = _activeTab?.title || "Chat";

				// Reuse existing per-tab agent if its underlying model still matches.
				// Otherwise abort + drop and rebuild with the new spec.
				const _existing = perTabAgents.getAgent(_initTabId);
				if (_existing) {
					const _cfg = (_existing as unknown as { config?: { model?: string } }).config;
					if (_cfg?.model === currentModel) {
						setAgent(_existing);
						setAgentReady(true);
						return;
					}
					perTabAgents.removeTabAgent(_initTabId);
				}

				// Map provider to runtime
				let runtime: "ollama" | "lmstudio" | "openrouter" = "ollama";
				if (currentProvider === "lmstudio") {
					runtime = "lmstudio";
				} else if (currentProvider === "openrouter" || currentProvider === "openrouter-free") {
					runtime = "openrouter";
				}

				const newAgent = new Agent({
					model: currentModel,
					runtime,
					workingDirectory: process.cwd(),
					maxTurns: 50,
					apiKey: process.env.OPENROUTER_API_KEY,
					events: buildEventsForTab(_initTabId, _initTabTitle),
				});
				const _readyOuter = await newAgent.isReady();
				if (_readyOuter) {
					perTabAgents.setAgent(_initTabId, newAgent);
					setAgent(newAgent);
					setAgentReady(true);
					try {
						const loraDir = require("node:path").join(
							require("node:os").homedir(),
							".8gent",
							"personal-lora",
						);
						const configPath = require("node:path").join(
							require("node:os").homedir(),
							".8gent",
							"config.json",
						);
						const fs = require("node:fs");
						if (fs.existsSync(loraDir) && fs.existsSync(configPath)) {
							const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
							if (cfg.personal?.autoRetrain !== false) {
								appendToTab(_initTabId, {
									id: `personal-lora-${Date.now()}`,
									role: "system" as const,
									content: `Personal LoRA detected. Loaded on top of ${currentModel}.`,
									timestamp: new Date(),
								});
							}
						}
					} catch {}
				} else {
					setAgentReady(false);
				}
			} catch (err) {
				setAgentReady(false);
				console.error("Agent init error:", err);
			}
		};
		initAgent();
	}, [currentModel, currentProvider, activeTabId, buildEventsForTab]);

	// When the active tab changes, surface its existing Agent (if any) into
	// the foreground `agent` ref so ESC / voice-chat / status reads stay
	// correct. The init effect above will build one when provider/model
	// resolve for tabs that haven't submitted yet.
	useEffect(() => {
		const existing = perTabAgents.getAgent(activeTabId);
		if (existing) {
			setAgent(existing);
			setAgentReady(true);
		}
	}, [activeTabId]);


	// Check onboarding status on mount
	useEffect(() => {
		const checkOnboarding = async () => {
			// Auto-detect environment (git config, ollama models, gh auth)
			const detected = await OnboardingManager.autoDetect();
			onboardingManager.applyAutoDetected(detected);

			// Also detect integrations (LM Studio, etc.)
			await onboardingManager.detectIntegrations();

			if (cliAutoApprove && onboardingManager.needsOnboarding()) {
				onboardingManager.skipAll();
				return;
			}

			if (onboardingManager.needsOnboarding()) {
				setShowOnboarding(true);
				setViewMode("onboarding");
				setOnboardingTotalSteps(onboardingManager.getTotalSteps());
				const question = onboardingManager.getNextQuestion();
				if (question) {
					applyOnboardingQuestion(question);
					setOnboardingSteps([{ question: question.question, status: "active" }]);
					setOnboardingStepIndex(0);
					// Speak the first question (first line only, gated by voice.outputEnabled)
					speakOnboardingLine(question.question);
					// Use setMessages directly to avoid stale closure issue
					setMessages((prev) => [
						...prev,
						{
							id: `onboard-${Date.now()}`,
							role: "system" as const,
							content: `∞ Welcome to 8gent, The Infinite Gentleman.\n\nBefore we begin, I'd like to learn about you.\n(Type /skip to skip any question, /skip all to skip onboarding)\n\n${question.question}`,
							timestamp: new Date(),
						},
					]);
				}
			} else if (onboardingManager.shouldAskClarification()) {
				const clarification = onboardingManager.getClarificationQuestion();
				if (clarification) {
					setMessages((prev) => [
						...prev,
						{
							id: `clarify-${Date.now()}`,
							role: "system" as const,
							content: `Quick question: ${clarification}`,
							timestamp: new Date(),
						},
					]);
				}
			}
		};
		checkOnboarding();
	}, [onboardingManager, cliAutoApprove, applyOnboardingQuestion]);

	// Handle /vision command — manage vision & OCR model settings
	const handleVisionCommand = useCallback(
		async (args: string[]) => {
			const {
				loadVisionConfig,
				saveVisionConfig,
				findVisionModel,
				findOCRModel,
				getRecommendedOCRModels,
			} = await import("../../../packages/eight/vision-router.js");
			const config = loadVisionConfig();

			const sub = args[0]?.toLowerCase();

			if (!sub || sub === "status") {
				// Show current vision config and available models
				const visionResult = await findVisionModel({
					taskType: "general",
					config,
				});
				const ocrResult = await findOCRModel();
				const available = visionResult.allAvailable;
				const ocrAvailable = ocrResult.allAvailable.filter((m: any) => m.ocrSpecialized);

				addSystemMessage(
					`Vision Settings:\n  Enabled: ${config.enabled ? "yes" : "no"}\n  Provider: ${config.provider}\n  Default model: ${config.defaultModel}\n  OCR model: ${config.ocrModel}\n  Prefer local: ${config.preferLocal ? "yes" : "no"}\n  Timeout: ${config.timeout}ms\n\nActive Vision: ${visionResult.model?.displayName || "none"}\nActive OCR: ${ocrResult.model?.displayName || "none"}\n\nAvailable vision models (${available.length}):\n${
						available.length > 0
							? available
									.map(
										(m: any) =>
											`  ${m.ocrSpecialized ? "[OCR]" : "[VIS]"} ${m.displayName} ${m.free ? "(free)" : ""}`,
									)
									.join("\n")
							: "  None found locally. Try: ollama pull qwen2.5-vl"
					}\n\nCommands:\n  /vision model <name>   — Set default vision model\n  /vision ocr <name>     — Set OCR model (or "auto")\n  /vision on|off         — Enable/disable vision\n  /vision pull           — Show recommended models to pull`,
				);
			} else if (sub === "model" && args[1]) {
				const model = args.slice(1).join(" ");
				saveVisionConfig({ defaultModel: model });
				addSystemMessage(
					`Vision model set to: ${model}\nThis will be used for image description tasks.`,
				);
			} else if (sub === "ocr" && args[1]) {
				const model = args.slice(1).join(" ");
				saveVisionConfig({ ocrModel: model });
				addSystemMessage(
					`OCR model set to: ${model}\n${model === "auto" ? "Will auto-discover the best OCR model." : "This will be used for text extraction tasks."}`,
				);
			} else if (sub === "on" || sub === "enable") {
				saveVisionConfig({ enabled: true });
				addSystemMessage("Vision enabled.");
			} else if (sub === "off" || sub === "disable") {
				saveVisionConfig({ enabled: false });
				addSystemMessage("Vision disabled. Images will not be interpreted.");
			} else if (sub === "local") {
				saveVisionConfig({ preferLocal: true, provider: "ollama" });
				addSystemMessage("Vision set to local-only (Ollama). Free and private.");
			} else if (sub === "cloud" || sub === "openrouter") {
				saveVisionConfig({ preferLocal: false, provider: "openrouter" });
				addSystemMessage("Vision set to cloud (OpenRouter). Includes free models.");
			} else if (sub === "pull") {
				const recommended = getRecommendedOCRModels();
				addSystemMessage(
					`Recommended vision/OCR models to pull:\n\n${recommended
						.map((m: any) => `  ollama pull ${m.model}  — ${m.description} (${m.size})`)
						.join(
							"\n",
						)}\n\nGeneral vision (default):\n  ollama pull qwen2.5-vl     — Best general vision + OCR (~5GB)\n  ollama pull minicpm-v       — Mobile-friendly (~5GB)\n  ollama pull llava           — Classic, widely supported (~4GB)\n  ollama pull moondream       — Tiny and fast (~1.7GB)`,
				);
			} else {
				addSystemMessage(
					`Unknown vision subcommand: "${sub}"\nUsage: /vision [status|model|ocr|on|off|local|cloud|pull]`,
				);
			}
		},
		[addSystemMessage],
	);

	// Handle slash commands. Async so individual cases (e.g. /spawn with
	// auto-install) can await long-running side effects without blocking
	// or hacking around it via .then() chains.
	const handleSlashCommand = useCallback(
		async (command: SlashCommand, args: string[]) => {
			switch (command) {
				case "help":
					addSystemMessage(
						"Available commands:\n" +
							"  /kanban (Ctrl+K) - Toggle kanban board\n" +
							"  /predict (Ctrl+P) - Show predicted next steps\n" +
							"  /avenues - Show planned avenues\n" +
							"  /design [task] - Get design system suggestions\n" +
							"  /evidence - Show full evidence breakdown\n" +
							"  /notes - Open scratchpad notes tab\n" +
							"  /ideas - Open idea capture tab\n" +
							"  /btw - Open sidequest queue tab\n" +
							"  /questions - Open research questions tab\n" +
							"  /projects - Open project overview tab\n" +
							"  /terminal - Open a live terminal tab (PTY shell)\n" +
							"  /auth [login|logout|status] - Authentication\n" +
							"  /github [issues|pr|repos] - GitHub integration\n" +
							"  /deploy - Trigger Vercel deploy\n" +
							"  /vercel [status|env|logs|projects|domains] - Vercel management\n" +
							"  /pet [start|stop|deck|card] - Lil Eight companion\n" +
							"  /voice record - Toggle voice input (Ctrl+R)\n" +
							"  /vision - Vision & OCR model settings\n" +
							"  /telegram - Connect a Telegram bot\n" +
							"  /router - Task router settings\n" +
							"  /plan - Show current plan status\n" +
							"  /session [name|list|resume] - Named session management\n" +
							"  /fork [label] - Fork conversation at current message\n" +
							"  /branch [list|switch <id>] - List or switch branches\n" +
							"  /status - Show session status\n" +
							"  /export - Export session as HTML\n" +
							"  /clear - Clear messages\n" +
							"  /quit - Exit 8gent Code\n" +
							"  /skills - List loaded skills (optional)\n" +
							"  /<skill> … - Any loaded skill name or alias expands to its prompt (e.g. /bdb, /billiondollarboardroom)\n\n" +
							"Keyboard shortcuts:\n" +
							"  Tab - Accept ghost suggestion\n" +
							"  Ctrl+T - New chat tab\n" +
							"  Ctrl+W - Close current tab\n" +
							"  Ctrl+1-9 - Switch to tab by number\n" +
							"  Shift+Tab - Cycle through tabs\n" +
							"  Ctrl+A - Toggle animations\n" +
							"  Ctrl+S - Toggle sound\n" +
							"  Ctrl+H - Toggle fancy header",
					);
					break;

				case "kanban":
					setViewMode((prev) => (prev === "kanban" ? "chat" : "kanban"));
					break;

				case "predict":
					setViewMode((prev) => (prev === "predict" ? "chat" : "predict"));
					break;

				case "avenues":
					setViewMode((prev) => (prev === "avenues" ? "chat" : "avenues"));
					break;

				case "plan":
					if (autoKanban.stats.total > 0) {
						addSystemMessage(
							`Task board (auto):\n  Backlog: ${autoKanban.columns.backlog.length}\n  Ready: ${autoKanban.columns.ready.length}\n  In Progress: ${autoKanban.columns.inProgress.length}\n  Done: ${autoKanban.stats.done} | Failed: ${autoKanban.stats.failed}\n  Total: ${autoKanban.stats.total} tasks`,
						);
					} else {
						addSystemMessage(
							`Current plan status:\n  Backlog: ${kanbanBoard.backlog.length} items\n  Ready: ${kanbanBoard.ready.length} items\n  In Progress: ${kanbanBoard.inProgress.length} items\n  Done: ${kanbanBoard.done.length} items`,
						);
					}
					break;

				case "status": {
					const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
					const mins = Math.floor(elapsed / 60);
					const secs = elapsed % 60;
					addSystemMessage(
						`Session Status:\n  Duration: ${mins}:${secs.toString().padStart(2, "0")}\n  Tokens used: ${totalTokens.toLocaleString()}\n  Commands: ${recentCommands.length}\n  Branch: ${currentBranch || "N/A"}\n  Animations: ${showAnimations ? "on" : "off"}\n  Sound: ${soundEnabled ? "on" : "off"}`,
					);
					break;
				}

				case "telegram": {
					const sub = args[0]?.toLowerCase();
					if (sub === "status") {
						const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
						const chatId = process.env.TELEGRAM_CHAT_ID || "not set";
						addSystemMessage(
							`Telegram Bot Status:\n  Token: ${hasToken ? "configured" : "not configured"}\n  Chat ID: ${chatId}\n\n${
								hasToken ? "Bot is running." : "Run /telegram setup to connect a bot."
							}`,
						);
					} else if (sub === "setup") {
						addSystemMessage(
							"Telegram Bot Setup:\n\n" +
								"1. Open Telegram and message @BotFather\n" +
								"2. Send /newbot and follow the prompts\n" +
								"3. Copy the bot token (looks like 123456:ABC-DEF...)\n" +
								"4. Add it to your environment:\n\n" +
								"   echo 'TELEGRAM_BOT_TOKEN=your_token_here' >> ~/.8gent/.env\n\n" +
								"5. Optionally restrict to your chat:\n" +
								"   - Message your bot, then check:\n" +
								"     curl https://api.telegram.org/bot<TOKEN>/getUpdates\n" +
								"   - Copy your chat_id and add:\n" +
								"     echo 'TELEGRAM_CHAT_ID=your_id' >> ~/.8gent/.env\n\n" +
								"6. Restart 8gent to activate the bot.\n\n" +
								"Your bot becomes a mobile interface to 8gent.",
						);
					} else {
						addSystemMessage(
							"Telegram commands:\n" +
								"  /telegram status  - Check connection\n" +
								"  /telegram setup   - Setup instructions",
						);
					}
					break;
				}

				case "clear":
					setMessages([
						{
							id: `cleared-${Date.now()}`,
							role: "system",
							content: "Screen cleared.",
							timestamp: new Date(),
						},
					]);
					break;

				case "export": {
					const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
					const mins = Math.floor(elapsed / 60);
					const secs = elapsed % 60;
					import("../../../packages/eight/session-export.js").then(({ saveSessionExport }) => {
						saveSessionExport(
							messages.map((m) => ({
								role: m.role,
								content: m.content,
								timestamp: m.timestamp,
							})),
							{
								sessionId: `session-${startTime.getTime()}`,
								model: currentModel || "unknown",
								duration: `${mins}m ${secs}s`,
							},
						).then((exportPath) => {
							addSystemMessage(`Session exported to ${exportPath}`);
						});
					});
					break;
				}

				case "fork": {
					const tree = sessionTreeRef.current;
					const tip = tree.tipId;
					if (!tip) {
						addSystemMessage("No messages to fork from.");
						break;
					}
					const label = args.length > 0 ? args.join(" ") : undefined;
					const branchId = tree.fork(tip, label);
					addSystemMessage(
						`Forked at current message. New branch: ${branchId} (${label || branchId})\nUse /branch list to see all branches.`,
					);
					break;
				}

				case "branch": {
					const tree = sessionTreeRef.current;
					const sub = args[0];
					if (!sub || sub === "list") {
						const branches = tree.getBranches();
						const lines = branches.map((b) => {
							const active = b.id === tree.activeBranch ? " *" : "";
							return `  ${b.id}${active} - ${b.label} (${b.messageCount} msgs)`;
						});
						addSystemMessage(`Branches:\n${lines.join("\n")}`);
					} else if (sub === "switch" && args[1]) {
						try {
							const history = tree.switchBranch(args[1]);
							const restored = history.map((n) => ({
								id: n.id,
								role: n.role as "user" | "assistant" | "system",
								content: typeof n.content === "string" ? n.content : JSON.stringify(n.content),
								timestamp: new Date(n.timestamp),
							}));
							setMessages(restored);
							addSystemMessage(`Switched to branch: ${args[1]}`);
						} catch (e: any) {
							addSystemMessage(`Branch error: ${e.message}`);
						}
					} else {
						addSystemMessage("Usage: /branch [list|switch <id>]");
					}
					break;
				}

				case "cron": {
					void (async () => {
						const { CronManager } = await import("../../../packages/cron/index.js");
						const mgr = new CronManager();
						const sub = args[0];
						if (!sub || sub === "list") {
							const jobs = mgr.list();
							if (jobs.length === 0) {
								addSystemMessage("No cron jobs. Use: /cron add <name> <schedule> <command>");
							} else {
								const lines = jobs.map((j: any) => {
									const s = j.enabled ? "ON" : "OFF";
									return `[${s}] ${j.id}  ${j.name}  ${j.schedule} -> ${j.command}`;
								});
								addSystemMessage(`Cron Jobs:\n${lines.join("\n")}`);
							}
						} else if (sub === "add" && args.length >= 4) {
							const job = mgr.add({
								name: args[1],
								schedule: args[2],
								command: args.slice(3).join(" "),
								enabled: true,
							});
							addSystemMessage(`Added cron job: ${job.id} (${job.name})`);
						} else if (sub === "remove" && args[1]) {
							const ok = mgr.remove(args[1]);
							addSystemMessage(ok ? `Removed job ${args[1]}` : `Job ${args[1]} not found`);
						} else if (sub === "enable" && args[1]) {
							mgr.enable(args[1]);
							addSystemMessage(`Enabled job ${args[1]}`);
						} else if (sub === "disable" && args[1]) {
							mgr.disable(args[1]);
							addSystemMessage(`Disabled job ${args[1]}`);
						} else {
							addSystemMessage(
								"Usage: /cron [list|add <name> <schedule> <cmd>|remove <id>|enable <id>|disable <id>]",
							);
						}
					})();
					break;
				}

				case "quit":
					if (activeSessionId && messages.length > 0) {
						const serializable = messages.map((m) => ({
							role: m.role,
							content: m.content,
						}));
						sessionMgr.update(activeSessionId, serializable, {
							model: currentModel,
							provider: currentProvider,
						});
					}
					flushSession();
					if (agent) agent.cleanup().catch(() => {});
					exit();
					break;

				case "infinite":
					// Toggle infinite mode - bypasses ALL permission checks
					if (infiniteModeActive) {
						disableInfiniteMode();
						setInfiniteModeActive(false);
						addSystemMessage("∞ INFINITE MODE DISABLED\n" + "Permission checks will resume.");
					} else {
						enableInfiniteMode();
						setInfiniteModeActive(true);
						addSystemMessage(
							"∞ INFINITE MODE ENABLED\n" +
								"All permissions bypassed. Autonomous execution until done.\n" +
								"No questions, no crashes stop me, self-healing errors.\n\n" +
								"Use /infinite again to disable.",
						);
					}
					break;

				case "onboarding": {
					// Start or restart onboarding
					onboardingManager.reset();
					setShowOnboarding(true);
					setViewMode("onboarding");
					setOnboardingTotalSteps(onboardingManager.getTotalSteps());
					setOnboardingStepIndex(0);
					const onboardQuestion = onboardingManager.getNextQuestion();
					if (onboardQuestion) {
						applyOnboardingQuestion(onboardQuestion);
						addSystemMessage(`∞ Let's get to know each other.\n\n${onboardQuestion.question}`);
					}
					break;
				}

				case "preferences": {
					// Show current preferences
					const user = onboardingManager.getUser();
					addSystemMessage(
						`∞ Your Preferences:\n\nName: ${user.identity.name || "Not set"}\nRole: ${user.identity.role || "Not set"}\nStyle: ${user.identity.communicationStyle || "Not set"}\nLanguage: ${user.identity.language}\nModel: ${user.preferences.model.default || currentModel}\nProvider: ${user.preferences.model.provider || currentProvider}\nVoice: ${user.preferences.voice.enabled ? "Enabled" : "Disabled"}\nAuto-commit: ${user.preferences.git.autoCommit ? "Yes" : "No"}\nUnderstanding: ${Math.round(user.understanding.confidenceScore * 100)}%\n\nUse /onboarding to reconfigure.`,
					);
					break;
				}

				case "skip":
					// Skip onboarding question
					if (showOnboarding) {
						if (args[0] === "all") {
							onboardingManager.skipAll();
							setShowOnboarding(false);
							setViewMode("chat");
							addSystemMessage(
								"Understood. I'll ask again later.\n" + "(The more I know, the better I serve.)",
							);
						} else {
							const nextQ = onboardingManager.skipQuestion();
							if (nextQ) {
								applyOnboardingQuestion(nextQ);
								addSystemMessage(nextQ.question);
							} else {
								setShowOnboarding(false);
								setOnboardingSelectChoices(null);
								setOnboardingProviderCheck(null);
								setOnboardingAgentDefault(null);
								setViewMode("chat");
								addSystemMessage("Onboarding complete. Let's begin.");
							}
						}
					}
					break;

				case "session": {
					const sub = args[0]?.toLowerCase();
					if (sub === "name" && args[1]) {
						const name = args.slice(1).join(" ");
						if (activeSessionId) {
							sessionMgr.rename(activeSessionId, name);
							addSystemMessage(`Session named: "${name}"`);
						} else {
							addSystemMessage("No active session to name.");
						}
					} else if (sub === "list") {
						const sessions = sessionMgr.list(10);
						if (sessions.length === 0) {
							addSystemMessage("No saved sessions.");
						} else {
							const lines = sessions.map((s) => {
								const label = s.name || `Session ${s.createdAt.slice(0, 10)}`;
								const ago = Math.floor((Date.now() - new Date(s.lastActiveAt).getTime()) / 60000);
								const timeStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
								return `  ${s.id}  ${label.slice(0, 30).padEnd(30)}  ${s.messageCount} msgs  ${timeStr}`;
							});
							addSystemMessage(`Recent sessions:\n${lines.join("\n")}`);
						}
					} else if (sub === "resume" && args[1]) {
						const target = args.slice(1).join(" ");
						const resumed = sessionMgr.resume(target);
						if (resumed) {
							setActiveSessionId(resumed.id);
							if (resumed.messages.length > 0) {
								const restored = resumed.messages.map((m, i) => ({
									id: `restored-${i}`,
									role: m.role as "user" | "assistant" | "system",
									content: m.content,
									timestamp: new Date(),
								}));
								setMessages(restored as Message[]);
							}
							addSystemMessage(
								`Resumed: "${resumed.name || resumed.id}" (${resumed.messageCount} messages)`,
							);
						} else {
							addSystemMessage(`Session "${target}" not found.`);
						}
					} else {
						addSystemMessage(
							"Usage:\n" +
								"  /session name <name>   - Name current session\n" +
								"  /session list          - Show recent sessions\n" +
								"  /session resume <name> - Resume a session by name or ID",
						);
					}
					break;
				}

				case "history":
					// Show history screen
					if (!agent) {
						addSystemMessage("No agent active - start a session first.");
						break;
					}
					agent
						.getSessionSync()
						.getRecentConversations(20)
						.then((convos) => {
							if (convos.length === 0) {
								addSystemMessage("No previous sessions found.");
							} else {
								addSystemMessage(
									`Found ${convos.length} sessions. Use /resume to pick one or /continue to restore the latest.`,
								);
							}
						})
						.catch(() => {
							addSystemMessage("Could not load session history.");
						});
					break;

				case "continue":
					// Continue most recent session
					if (!agent) {
						addSystemMessage("No agent active — start a session first.");
						break;
					}
					agent
						.getSessionSync()
						.getRecentConversations(1)
						.then((convos) => {
							if (convos.length === 0 || !convos[0].checkpointData) {
								addSystemMessage("No session to continue. Start chatting to create history.");
							} else {
								try {
									const messages = JSON.parse(convos[0].checkpointData);
									agent.restoreFromCheckpoint(messages);
									addSystemMessage(
										`Restored session: "${convos[0].title}"\n  ${convos[0].messageCount} messages - ${convos[0].model}\n  Last active: ${new Date(convos[0].lastActiveAt).toLocaleString()}\n\nContext restored. Continue where you left off.`,
									);
								} catch {
									addSystemMessage("Failed to parse checkpoint data.");
								}
							}
						})
						.catch(() => {
							addSystemMessage("Could not load session history.");
						});
					break;

				case "resume":
					// Show last 5 sessions to pick from
					if (!agent) {
						addSystemMessage("No agent active — start a session first.");
						break;
					}
					agent
						.getSessionSync()
						.getRecentConversations(5)
						.then((convos) => {
							if (convos.length === 0) {
								addSystemMessage("No previous sessions found.");
							} else {
								const lines = ["Recent sessions (reply with number to resume):\n"];
								convos.forEach((c: any, i: number) => {
									const ago = Math.floor((Date.now() - c.lastActiveAt) / 60000);
									const timeStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
									lines.push(
										`  ${i + 1}. ${c.title.slice(0, 50)} — ${c.model} - ${c.messageCount} msgs - ${timeStr}`,
									);
								});
								addSystemMessage(lines.join("\n"));
							}
						})
						.catch(() => {
							addSystemMessage("Could not load session history.");
						});
					break;

				case "compact":
					// Summarize current conversation
					if (!agent) {
						addSystemMessage("No agent active.");
						break;
					}
					addSystemMessage("Compacting conversation history...");
					{
						const history = agent.getMessageHistory();
						const userMsgs = history.filter((m) => m.role === "user").length;
						const assistantMsgs = history.filter((m) => m.role === "assistant").length;
						// Keep system prompt + last 4 messages
						if (history.length > 5) {
							const systemMsg = history[0];
							const recentMsgs = history.slice(-4);
							agent.restoreFromCheckpoint([systemMsg, ...recentMsgs]);
							addSystemMessage(
								`Compacted: ${userMsgs} user + ${assistantMsgs} assistant messages -> kept last 4.\nContext trimmed. Older messages removed from active memory.`,
							);
						} else {
							addSystemMessage("Conversation too short to compact.");
						}
					}
					break;

				case "chat":
					if (orchestration.chatMode) {
						orchestration.exitChatMode();
						addSystemMessage("Chat mode disabled. Returning to normal mode.");
					} else {
						orchestration.enterChatMode();
						addSystemMessage(
							`Chat mode enabled. Background work continues.\nShift+Tab to cycle agents. ESC to exit chat mode.\nCurrently addressing: ${orchestration.activeAgentName}`,
						);
					}
					break;

				case "agent": {
					const agentSub = args[0] || "list";
					if (agentSub === "list") {
						if (orchestration.agents.length === 0) {
							addSystemMessage(
								"No active sub-agents. Eight is operating solo.\n\nUse /agent spawn <persona> <task> to spawn one.",
							);
						} else {
							const lines = orchestration.agents.map(
								(a) => `  ${a.icon} ${a.name} (${a.role}) — ${a.status}\n    Task: ${a.task}`,
							);
							addSystemMessage(
								`Active agents (${orchestration.agents.length + 1}):\n\n  Eight (orchestrator) — running\n${lines.join("\n")}`,
							);
						}
					} else if (agentSub === "spawn") {
						const personaId = args[1];
						const task = args.slice(2).join(" ");
						if (!personaId) {
							addSystemMessage(
								"Usage: /agent spawn <persona> <task>\n\nPersonas: winston, larry, curly, mo, doc",
							);
						} else {
							orchestration.spawnAgent(personaId, task || "General assistance");
							addSystemMessage(`Spawn request submitted for ${personaId}...`);
						}
					} else if (agentSub === "kill") {
						const killId = args[1];
						if (!killId) {
							addSystemMessage(
								"Usage: /agent kill <agent-id>\n\nUse /agent list to see active agents.",
							);
						} else {
							const found = orchestration.agents.find(
								(a) => a.id.includes(killId) || a.name.toLowerCase() === killId.toLowerCase(),
							);
							if (found) {
								orchestration.killAgent(found.id);
								addSystemMessage(`Killed agent: ${found.name} (${found.role})`);
							} else {
								addSystemMessage(`Agent "${killId}" not found.`);
							}
						}
					} else if (agentSub === "auto") {
						orchestration.toggleAutoSpawn();
						addSystemMessage(
							`Auto-spawn: ${!orchestration.autoSpawn ? "ENABLED" : "DISABLED"}\n${!orchestration.autoSpawn ? "Eight will automatically spawn sub-agents without asking." : "Eight will ask before spawning sub-agents."}`,
						);
					} else if (agentSub === "settings") {
						addSystemMessage(
							`Agent Settings:\n\n  Auto-spawn: ${orchestration.autoSpawn ? "on" : "off"}\n  Active agents: ${orchestration.agents.length}\n  Pending spawns: ${orchestration.pendingSpawns.length}\n\nCommands:\n  /agent list       — Show active agents\n  /agent spawn <p>  — Spawn persona (winston/larry/curly/mo/doc)\n  /agent kill <id>  — Kill an agent\n  /agent auto       — Toggle auto-spawn`,
						);
					}
					break;
				}

				case "animations":
					// Show animation showcase
					if (args.length > 0) {
						const animName = args[0].toLowerCase();
						if (isValidAnimation(animName)) {
							setCurrentAnimation(animName);
							setViewMode("animations");
						} else {
							addSystemMessage(
								`Unknown animation: "${args[0]}"\n\nAvailable: matrix, fire, dna, stars, dots, glitch, confetti, wave, gradient, all`,
							);
						}
					} else {
						// Show animation list
						setCurrentAnimation("all");
						setViewMode("animations");
					}
					break;

				case "adhd": {
					// ADHD mode — focus toolkit
					const adhdAudio = getADHDAudio();
					const sub = args[0]?.toLowerCase();

					if (!sub) {
						// Toggle text mode
						const newMode = !adhdMode;
						setAdhdMode(newMode);
						addSystemMessage(newMode ? ADHD_MODE_ENABLED_MSG : ADHD_MODE_DISABLED_MSG);
						break;
					}

					// Text mode toggles
					if (sub === "on" || sub === "enable" || sub === "true") {
						setAdhdMode(true);
						addSystemMessage(ADHD_MODE_ENABLED_MSG);
					} else if (sub === "off" || sub === "disable" || sub === "false") {
						setAdhdMode(false);
						adhdAudio.stop();
						addSystemMessage(ADHD_MODE_DISABLED_MSG);
					}
					// Audio controls
					else if (sub === "stop" || sub === "pause") {
						adhdAudio.stop();
						addSystemMessage(
							`Audio paused. Text mode still ${adhdMode ? "on" : "off"}. Play again with /adhd lofi etc.`,
						);
					}
					// Config: /adhd config, /adhd set <key> <value>
					else if (sub === "config" || sub === "settings") {
						const cfg = adhdAudio.config;
						addSystemMessage(
							`ADHD Audio Config\n\n  duration:       ${cfg.duration}s\n  bpm:            ${cfg.bpm ?? "auto (per preset)"}\n  inferenceSteps: ${cfg.inferenceSteps}\n  guidanceScale:  ${cfg.guidanceScale}\n  batchSize:      ${cfg.batchSize}\n  apiUrl:         ${cfg.apiUrl}\n\nSet with: /adhd set <key> <value>\nExample:  /adhd set duration 120`,
						);
					} else if (sub === "set" && args.length >= 3) {
						const key = args[1].toLowerCase();
						const val = args[2];
						const validKeys: Record<string, string> = {
							duration: "duration",
							length: "duration",
							time: "duration",
							bpm: "bpm",
							tempo: "bpm",
							steps: "inferenceSteps",
							inferencesteps: "inferenceSteps",
							quality: "inferenceSteps",
							guidance: "guidanceScale",
							guidancescale: "guidanceScale",
							batch: "batchSize",
							batchsize: "batchSize",
							api: "apiUrl",
							apiurl: "apiUrl",
							url: "apiUrl",
						};
						const configKey = validKeys[key];
						if (!configKey) {
							addSystemMessage(
								`Unknown config key "${key}". Valid: ${Object.keys(validKeys).join(", ")}`,
							);
						} else if (configKey === "apiUrl") {
							const updated = adhdAudio.setConfig({ apiUrl: val });
							addSystemMessage(`apiUrl set to ${updated.apiUrl}`);
						} else {
							const numVal = Number(val);
							if (Number.isNaN(numVal)) {
								addSystemMessage(`"${val}" isn't a number.`);
							} else if (configKey === "bpm" && val === "auto") {
								adhdAudio.setConfig({ bpm: null });
								addSystemMessage("bpm set to auto (uses preset default).");
							} else {
								const updated = adhdAudio.setConfig({
									[configKey]: numVal,
								} as any);
								addSystemMessage(
									`${configKey} set to ${(updated as any)[configKey]}. Cached audio cleared.`,
								);
							}
						}
					}
					// Clear cache
					else if (sub === "clear" || sub === "regenerate" || sub === "regen") {
						adhdAudio.clearCache();
						addSystemMessage("Audio cache cleared. Next play will regenerate fresh tracks.");
					}
					// Soundscapes: lofi, rainsound, whitenoise, ambient, classical
					else if (["lofi", "rainsound", "whitenoise", "ambient", "classical"].includes(sub)) {
						if (!adhdMode) {
							setAdhdMode(true);
							addSystemMessage(ADHD_MODE_ENABLED_MSG);
						}
						addSystemMessage(`Loading ${sub}...`);
						adhdAudio.play(sub as ADHDSoundscape).then((result) => {
							addSystemMessage(result.message);
						});
					} else {
						const cfg = adhdAudio.config;
						addSystemMessage(
							`ADHD Mode — your focus toolkit\n\n  /adhd              Toggle text mode\n  /adhd on|off       Enable/disable\n\n  Audio:\n  /adhd lofi         Lofi beats\n  /adhd rainsound    Rain sounds\n  /adhd whitenoise   White noise\n  /adhd ambient      Ambient synths\n  /adhd classical    Soft piano\n  /adhd stop         Stop audio\n\n  Config:\n  /adhd config       Show current settings\n  /adhd set <k> <v>  Change a setting\n  /adhd regen        Clear cache & regenerate\n\nStatus: text=${adhdMode ? "on" : "off"} · audio=${adhdAudio.isPlaying ? adhdAudio.current : "off"} · duration=${cfg.duration}s`,
						);
					}
					break;
				}

				case "router": {
					const router = getTaskRouter();
					const sub = args[0]?.toLowerCase();

					if (!sub || sub === "status") {
						const cfg = router.getConfig();
						const lines = [
							`Task Router — ${cfg.enabled ? "enabled" : "disabled"}`,
							"",
							"Slot Assignments:",
							`  code:      ${cfg.slots.code.model} (${cfg.slots.code.provider})`,
							`  reasoning: ${cfg.slots.reasoning.model} (${cfg.slots.reasoning.provider})`,
							`  simple:    ${cfg.slots.simple.model} (${cfg.slots.simple.provider})`,
							`  creative:  ${cfg.slots.creative.model} (${cfg.slots.creative.provider})`,
							"",
							`  classifier: ${cfg.classifierModel}`,
							`  threshold:  ${cfg.confidenceThreshold}`,
							`  default:    ${cfg.defaultModel.model}`,
							"",
							"Commands:",
							"  /router on|off           Enable/disable routing",
							"  /router set <cat> <model> Assign model to category",
							"  /router test <prompt>     Test classification",
							"  /router stats             Show routing stats",
							"  /router auto              Auto-assign from Ollama models",
						];
						addSystemMessage(lines.join("\n"));
					} else if (sub === "on" || sub === "enable") {
						router.setConfig({ enabled: true });
						addSystemMessage("Task router enabled. Messages will be classified and routed.");
					} else if (sub === "off" || sub === "disable") {
						router.setConfig({ enabled: false });
						addSystemMessage("Task router disabled. All messages go to default model.");
					} else if (sub === "set" && args.length >= 3) {
						const cat = args[1].toLowerCase() as TaskCategory;
						const model = args.slice(2).join(" ");
						if (!["code", "reasoning", "simple", "creative"].includes(cat)) {
							addSystemMessage(`Unknown category "${cat}". Use: code, reasoning, simple, creative`);
						} else {
							router.setSlot(cat, {
								model,
								provider: (currentProvider as any) || "ollama",
							});
							addSystemMessage(`${cat} → ${model}`);
						}
					} else if (sub === "test" && args.length >= 2) {
						const testPrompt = args.slice(1).join(" ");
						addSystemMessage(`Classifying: "${testPrompt}"...`);
						router
							.route(testPrompt)
							.then((decision) => {
								addSystemMessage(
									`Category: ${decision.category} (${(decision.confidence * 100).toFixed(0)}%)\n` +
										`Model: ${decision.model}\n` +
										`Reasoning: ${decision.reasoning}`,
								);
							})
							.catch((err) => {
								addSystemMessage(
									`Classification failed: ${err instanceof Error ? err.message : String(err)}`,
								);
							});
					} else if (sub === "stats") {
						const stats = getRouterStats();
						const lines = [
							`Router Stats (${stats.totalRouted} total routes)`,
							"",
							"By Category:",
							...Object.entries(stats.byCategory).map(([k, v]) => `  ${k}: ${v}`),
							"",
							"By Model:",
							...Object.entries(stats.byModel).map(
								([k, v]) => `  ${k}: ${v.routed} routes, avg ${Math.round(v.avgLatencyMs)}ms`,
							),
						];
						addSystemMessage(lines.join("\n"));
					} else if (sub === "classifier" && args.length >= 2) {
						router.setConfig({ classifierModel: args.slice(1).join(" ") });
						addSystemMessage(`Classifier model set to ${args.slice(1).join(" ")}`);
					} else if (sub === "threshold" && args[1]) {
						const val = Number.parseFloat(args[1]);
						if (!Number.isNaN(val)) {
							router.setConfig({
								confidenceThreshold: Math.max(0, Math.min(1, val)),
							});
							addSystemMessage(`Confidence threshold set to ${val}`);
						}
					} else if (sub === "auto") {
						addSystemMessage("Scanning Ollama models...");
						router.autoAssign().then((changes) => {
							if (changes.length === 0) {
								addSystemMessage("No changes — slots already optimal.");
							} else {
								addSystemMessage(`Auto-assigned:\n${changes.map((c) => `  ${c}`).join("\n")}`);
							}
						});
					} else {
						addSystemMessage("Unknown router command. Try /router for help.");
					}
					break;
				}

				case "rename": {
					// Rename current tab: /rename New Name
					const newName = args.join(" ").trim();
					if (!newName) {
						addSystemMessage("Usage: /rename My New Tab Name");
					} else if (workspaceTabs.activeTab) {
						workspaceTabs.renameTab(workspaceTabs.activeTab.id, newName);
						addSystemMessage(`Tab renamed to "${newName}"`);
					}
					break;
				}

				case "settings": {
					// Open the settings tab (singleton — switches if it already exists).
					workspaceTabs.addTab("settings", "Settings");
					break;
				}

				case "quiet": {
					// Kill any in-flight launch instrumental from the intro splash.
					stopIntroMusic();
					addSystemMessage("Intro music stopped.");
					break;
				}

				case "spawn": {
					// /spawn <preset> [install] — open a chat tab whose backing brain is an external CLI.
					// If the binary is not on $PATH, kick off the auto-install recipe before spawning.
					const presetId = (args[0] || "").toLowerCase().trim();
					const subCommand = (args[1] || "").toLowerCase().trim();
					if (!presetId) {
						addSystemMessage(
							`Usage: /spawn <agent> [install]\nAvailable: ${listPresetIds().join(", ")}\nExample: /spawn claude   (auto-installs if missing)\n         /spawn hermes install   (force re-install)`,
						);
						break;
					}
					const preset = getPreset(presetId);
					if (!preset) {
						addSystemMessage(
							`Unknown agent "${presetId}". Available: ${listPresetIds().join(", ")}`,
						);
						break;
					}

					// Force-install path: `/spawn <id> install` reinstalls even if already on PATH.
					const force = subCommand === "install";
					const needsInstall = force || !isInstalled(preset);
					if (needsInstall) {
						if (!preset.install) {
							const homepageHint = preset.homepage
								? `\nProject homepage: ${preset.homepage}`
								: "";
							addSystemMessage(
								`${preset.command} is not on $PATH and no auto-install recipe is configured. Install it manually then run /spawn ${preset.id} again.${homepageHint}`,
							);
							break;
						}
						addSystemMessage(
							`Installing ${preset.label} via \`${preset.install.command}\`. This may take 30-90 seconds...`,
						);
						const ok = await ensureInstalled(preset, (line, source) => {
							if (source === "info") {
								addSystemMessage(`[install] ${line}`);
							}
							// Verbose stdout/stderr is suppressed — npm/pip can be noisy.
							// We only surface the summary lines via `source: "info"`.
						});
						if (!ok) {
							addSystemMessage(
								`Install of ${preset.label} did not complete. ${preset.install.notes ?? ""}`.trim(),
							);
							break;
						}
						addSystemMessage(
							`Installed ${preset.label}.${preset.install.notes ? ` Note: ${preset.install.notes}` : ""}`,
						);
					}

					const tab = workspaceTabs.addTab("chat", preset.label);
					if (!tab) {
						addSystemMessage("Could not create tab (max reached?)");
						break;
					}
					workspaceTabs.updateTabData(tab.id, {
						externalAgent: { presetId: preset.id },
						label: preset.label,
					});
					addSystemMessage(
						`Spawned tab "${preset.label}" backed by \`${preset.command}\`. Type a prompt - 8gent will hand it to the nested CLI each turn.`,
					);
					break;
				}

				case "debug": {
					// Debug CLI inside TUI — runs bin/debug.ts and shows output
					const debugCmd = args.length > 0 ? args.join(" ") : "sessions";
					const debugScript = require("node:path").join(process.cwd(), "bin", "debug.ts");
					try {
						const result = Bun.spawnSync(["bun", "run", debugScript, ...debugCmd.split(" ")], {
							cwd: process.cwd(),
							env: { ...process.env, NO_COLOR: "1" }, // strip ANSI for clean display
							timeout: 10000,
						});
						const output = result.stdout?.toString()?.trim() || "No output";
						const stderr = result.stderr?.toString()?.trim();
						if (stderr && result.exitCode !== 0) {
							addSystemMessage(`Debug error: ${stderr.slice(0, 200)}`);
						} else {
							addSystemMessage(output.slice(0, 2000));
						}
					} catch (err) {
						addSystemMessage(`Debug failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}

				case "music": {
					// Interactive music generation via ACE-Step
					const musicAudio = getADHDAudio();
					const musicSub = args[0]?.toLowerCase();

					if (!musicSub) {
						// Open music as a persistent tab
						workspaceTabs.addTab("music");
					}
					// Quick play aliases
					else if (
						[
							"lofi",
							"rain",
							"rainsound",
							"white",
							"whitenoise",
							"ambient",
							"piano",
							"classical",
						].includes(musicSub)
					) {
						const keyMap: Record<string, string> = {
							rain: "rainsound",
							white: "whitenoise",
							piano: "classical",
						};
						const key = keyMap[musicSub] || musicSub;
						musicAudio.onProgress = (msg) => addSystemMessage(msg);
						musicAudio.play(key as any).then((r) => {
							addSystemMessage(r.message);
							musicAudio.onProgress = null;
						});
					}
					// Custom prompt generation
					else if (musicSub === "gen" && args.length >= 2) {
						const customPrompt = args.slice(1).join(" ");
						const cfg = musicAudio.config;
						addSystemMessage(`🎵 Generating "${customPrompt}" (${cfg.duration}s)...`);

						// Use ACE-Step API directly for custom prompts
						fetch(`${cfg.apiUrl}/release_task`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								prompt: `${customPrompt}, instrumental`,
								lyrics: "[instrumental]",
								audio_duration: cfg.duration,
								bpm: cfg.bpm || null,
								inference_steps: cfg.inferenceSteps,
								guidance_scale: cfg.guidanceScale,
								use_random_seed: true,
								task_type: "text2music",
								thinking: false,
								use_cot_caption: false,
								use_cot_language: false,
								batch_size: 1,
							}),
						})
							.then((r) => r.json())
							.then((data: any) => {
								const taskId = data?.data?.task_id;
								if (!taskId) {
									addSystemMessage("Failed to start generation. Is ACE-Step running?");
									return;
								}
								addSystemMessage(`🎵 Generating... (task ${taskId.slice(0, 8)})`);

								// Poll for result with progress updates
								const poll = async () => {
									const maxWait = 300000;
									const start = Date.now();
									let lastUpdate = 0;
									while (Date.now() - start < maxWait) {
										const elapsed = Math.round((Date.now() - start) / 1000);

										// Progress update every 10s
										if (elapsed - lastUpdate >= 10) {
											lastUpdate = elapsed;
											addSystemMessage(`🎵 Still generating... ${elapsed}s elapsed`);
										}

										try {
											const res = await fetch(`${cfg.apiUrl}/query_result`, {
												method: "POST",
												headers: { "Content-Type": "application/json" },
												body: JSON.stringify({ task_id_list: [taskId] }),
											});
											const result: any = await res.json();
											const job = result?.data?.[0];
											if (job?.status === 1) {
												const results = JSON.parse(job.result);
												const audioUrl = results?.[0]?.file;
												if (audioUrl) {
													// Download and play
													const fullUrl = audioUrl.startsWith("http")
														? audioUrl
														: `${cfg.apiUrl}${audioUrl}`;
													const audioRes = await fetch(fullUrl);
													const buf = await audioRes.arrayBuffer();
													const { join } = await import("node:path");
													const cachePath = join(
														process.env.HOME || "~",
														".8gent",
														"adhd-audio",
														"custom.mp3",
													);
													await Bun.write(cachePath, buf);
													addSystemMessage("Track ready! Playing on loop. /music stop to end.");
													// Play via afplay loop
													const { spawn } = await import("bun");
													const loopPlay = () => {
														const proc = spawn(["afplay", cachePath], {
															stdout: "ignore",
															stderr: "ignore",
															onExit: () => {
																if (musicAudio.isPlaying) loopPlay();
															},
														});
													};
													loopPlay();
													return;
												}
											}
											if (job?.status === 2) {
												addSystemMessage("Generation failed. Try a different prompt.");
												return;
											}
										} catch {}
										await Bun.sleep(2000);
									}
									addSystemMessage(
										"Generation timed out (5 min). Try shorter duration: /music set duration 60",
									);
								};
								poll();
							})
							.catch(() => {
								addSystemMessage(
									"ACE-Step isn't running. Start it first:\n  cd ~/ace-step/ace-step-1.5 && uv run --frozen python -m uvicorn acestep.api_server:app --host 0.0.0.0 --port 8001 --workers 1",
								);
							});
					}
					// Controls
					else if (musicSub === "stop" || musicSub === "pause") {
						musicAudio.stop();
						addSystemMessage("Music stopped.");
					} else if (musicSub === "player" || musicSub === "playlist" || musicSub === "view") {
						setViewMode("music");
					} else if (musicSub === "config" || musicSub === "settings") {
						const cfg = musicAudio.config;
						addSystemMessage(
							`Music Config\n\n  duration:  ${cfg.duration}s (${Math.round(cfg.duration / 60)}min)\n  bpm:       ${cfg.bpm ?? "auto"}\n  quality:   ${cfg.inferenceSteps} steps\n  guidance:  ${cfg.guidanceScale}\n  api:       ${cfg.apiUrl}\n\nChange with: /music set <key> <value>`,
						);
					} else if (musicSub === "set" && args.length >= 3) {
						const key = args[1].toLowerCase();
						const val = args[2];
						const keyMap: Record<string, string> = {
							duration: "duration",
							length: "duration",
							time: "duration",
							bpm: "bpm",
							tempo: "bpm",
							steps: "inferenceSteps",
							quality: "inferenceSteps",
							guidance: "guidanceScale",
						};
						const configKey = keyMap[key];
						if (!configKey) {
							addSystemMessage("Unknown key. Use: duration, bpm, steps, guidance");
						} else {
							const numVal = Number(val);
							if (Number.isNaN(numVal)) {
								addSystemMessage(`"${val}" isn't a number.`);
							} else {
								musicAudio.setConfig({ [configKey]: numVal } as any);
								addSystemMessage(
									`${configKey} set to ${numVal}. Cache cleared — next play regenerates.`,
								);
							}
						}
					} else if (musicSub === "regen" || musicSub === "clear") {
						musicAudio.clearCache();
						addSystemMessage("Cache cleared. Next play will generate fresh tracks.");
					} else {
						addSystemMessage(`Unknown: /music ${musicSub}. Try /music for help.`);
					}
					break;
				}

				case "dj": {
					const djSub = args[0] || "";
					const djArgs = args.slice(1);
					// Lazy import the DJ hook handler
					import("./hooks/useDJ.js")
						.then(async ({ useDJ: _ }) => {
							// Direct instantiation since we can't use hooks outside React
							const { DJ } = await import("../../../packages/music/dj.js");
							const dj = new DJ();
							let result: string;
							switch (djSub) {
								case "play":
									result = await dj.play(djArgs.join(" ") || "");
									break;
								case "radio":
									result = await dj.radio(djArgs.join(" ") || "lofi");
									break;
								case "pause":
									result = await dj.pause();
									break;
								case "stop":
									dj.stop();
									try {
										require("node:child_process").execSync("pkill -f afplay 2>/dev/null");
									} catch {}
									result = "Stopped.";
									break;
								case "skip":
									result = await dj.skip();
									break;
								case "np":
									result = await dj.nowPlaying();
									break;
								case "vol":
								case "volume":
									result = await dj.volume(Number.parseInt(djArgs[0] || "80"));
									break;
								case "loop":
								case "repeat":
									result = dj.repeat();
									break;
								case "queue":
									result = dj.queue(djArgs.join(" "));
									break;
								case "dl":
								case "download":
									result = dj.download(djArgs[0] || "");
									break;
								case "bpm":
									result = dj.bpm(djArgs[0] || "");
									break;
								case "mix":
									result = dj.mix(
										djArgs[0] || "",
										djArgs[1] || "",
										Number.parseInt(djArgs[2] || "5"),
									);
									break;
								case "resume":
									result = await dj.resume();
									break;
								case "presets":
								case "genres":
									result = `Radio: ${dj.radioPresets().join(", ")}`;
									break;
								case "doctor":
								case "status": {
									const d = dj.doctor();
									result = `mpv:${d.mpv ? "OK" : "X"} yt-dlp:${d.ytdlp ? "OK" : "X"} ffmpeg:${d.ffmpeg ? "OK" : "X"} sox:${d.sox ? "OK" : "X"}`;
									break;
								}
								case "produce":
								case "gen": {
									addSystemMessage(`Producing ${djArgs[0] || "house"} track...`);
									const { MusicProducer } = await import("../../../packages/music/producer.js");
									const p = new MusicProducer();
									const t = await p.produce({
										genre: (djArgs[0] || "house") as any,
										durationSec: 60,
										loop: true,
									});
									p.loop(t);
									result = `Playing: ${t.genre} at ${t.bpm} BPM (${t.layers.length} layers)`;
									break;
								}
								default:
									result =
										"DJ Eight\n  /dj play <query>  - YouTube\n  /dj radio <genre>  - Internet radio\n  /dj produce <genre> - Generate track\n  /dj pause/stop/skip/np/vol/loop/queue\n  /dj dl <url> - Download\n  /dj bpm <file> - Detect BPM\n  /dj doctor - Check tools";
							}
							addSystemMessage(result);
						})
						.catch((err) => addSystemMessage(`DJ error: ${err.message}`));
					break;
				}

				case "pet": {
					const petSub = args[0]?.toLowerCase() || "start";
					import("../../../packages/pet/companion.js")
						.then(async ({ generateCompanion, formatDeckSummary }) => {
							const { execSync, spawn: spawnProc } = await import("node:child_process");
							const fs = await import("node:fs");
							const path = await import("node:path");

							switch (petSub) {
								case "start": {
									// Generate companion first so we can write its data
									const sessionId = `session-${Date.now()}`;
									const companion = generateCompanion(sessionId);

									// Write companion data for the dock pet to read
									const companionData = {
										fullName: companion.fullName,
										species: companion.species,
										element: companion.element,
										rarity: companion.rarity,
										accessory: companion.accessory,
										shiny: companion.shiny,
										palette: companion.palette,
										lore: companion.lore,
										stats: companion.stats,
									};
									const home = process.env.HOME || "~";
									fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
									fs.writeFileSync(
										path.join(home, ".8gent", "active-companion.json"),
										JSON.stringify(companionData, null, 2),
									);

									// Kill ALL existing dock pets (SIGTERM first for clean window close, then SIGKILL)
									if (process.platform === "darwin") {
										try {
											execSync("pkill -f 'Lil.Eight' 2>/dev/null");
										} catch {}
										try {
											execSync("sleep 0.5 && pkill -9 -f 'Lil.Eight' 2>/dev/null &");
										} catch {}
									}

									// Spawn dock pet on macOS
									if (process.platform === "darwin") {
										// Try multiple paths: cwd (source), __dirname relative, home .8gent
										const candidates = [
											path.join(process.cwd(), "bin/lil-eight.sh"),
											path.join(__dirname, "../bin/lil-eight.sh"),
											path.join(__dirname, "../../bin/lil-eight.sh"),
											path.join(process.env.HOME || "~", "8gent-code/bin/lil-eight.sh"),
										];
										const lilEightScript = candidates.find((p) => fs.existsSync(p));
										if (lilEightScript) {
											const pet = spawnProc("bash", [lilEightScript, "start"], {
												detached: true,
												stdio: "ignore",
											});
											pet.unref();
											addSystemMessage(`[pet] ${companion.fullName} spawned on Dock`);
										} else {
											addSystemMessage(
												`[pet] lil-eight.sh not found. Tried:\n  ${candidates.join("\n  ")}`,
											);
										}
									} else {
										// Linux/Windows: terminal pet mode
										addSystemMessage(`[pet] ${companion.fullName} active (terminal mode)`);
									}
									// Show companion card
									addSystemMessage(companion.card.replace(/\x1b\[[0-9;]*m/g, ""));
									break;
								}
								case "stop": {
									try {
										execSync("pkill -f 'Lil.Eight' 2>/dev/null");
										execSync("sleep 0.5 && pkill -9 -f 'Lil.Eight' 2>/dev/null &");
										addSystemMessage("[pet] All companions dismissed");
									} catch {
										addSystemMessage("[pet] Not running");
									}
									break;
								}
								case "deck":
								case "collection": {
									addSystemMessage(formatDeckSummary().replace(/\x1b\[[0-9;]*m/g, ""));
									break;
								}
								case "card": {
									const c = generateCompanion(`card-${Date.now()}`);
									addSystemMessage(c.card.replace(/\x1b\[[0-9;]*m/g, ""));
									break;
								}
								default:
									addSystemMessage(
										"Lil Eight\n  /pet start - Spawn dock companion\n  /pet stop - Dismiss\n  /pet deck - View collection\n  /pet card - Roll a new companion card",
									);
							}
						})
						.catch((err: Error) => addSystemMessage(`Pet error: ${err.message}`));
					break;
				}

				case "design": {
					// Trigger design agent manually
					const designTask = args.length > 0 ? args.join(" ") : "create a new UI component";
					designAgent.process(designTask).then((result) => {
						if (result.needsIntervention && result.suggestions) {
							setDesignIntro(result.message.split("\n")[0] || "Pick a design direction:");
							setDesignSuggestions(result.suggestions);
							setViewMode("design");
						} else {
							addSystemMessage(
								"No design decisions needed for this task.\nTry: /design create a landing page",
							);
						}
					});
					break;
				}

				case "evidence": {
					// Show full evidence breakdown
					if (!agent) {
						addSystemMessage("No agent active — evidence requires a running session.");
						break;
					}
					const evidence = agent.getSessionEvidence();
					if (evidence.length === 0) {
						addSystemMessage(
							"No evidence collected yet.\nEvidence is gathered after write_file, edit_file, run_command, and git_commit.",
						);
						break;
					}
					const evSummary = evidence.reduce(
						(acc, ev) => {
							acc.total++;
							if (ev.verified) acc.verified++;
							else acc.failed++;
							acc.byType[ev.type] = (acc.byType[ev.type] || 0) + 1;
							return acc;
						},
						{
							total: 0,
							verified: 0,
							failed: 0,
							byType: {} as Record<string, number>,
						},
					);
					const evLines = [
						`Evidence Breakdown (${evSummary.verified}/${evSummary.total} verified):`,
						"",
					];
					for (const ev of evidence) {
						const icon = ev.verified ? "\u2713" : "\u2717";
						const label = `[${ev.type}]`.padEnd(18);
						evLines.push(`  ${icon} ${label} ${ev.description}`);
					}
					evLines.push("");
					evLines.push("By type:");
					for (const [type, count] of Object.entries(evSummary.byType)) {
						evLines.push(`  ${type}: ${count}`);
					}
					addSystemMessage(evLines.join("\n"));
					break;
				}

				case "voice":
					// Enhanced voice command — toggle STT recording or voice chat
					if (args[0] === "chat" || args[0] === "conversation" || args[0] === "talk") {
						if (voiceChat.isActive) {
							voiceChat.stop();
							// Tell the agent voice chat is OFF so it stops adding the
							// "you're in a phone call" segment to its system prompt.
							import("../../../packages/ai/tools").then((m) =>
								m.setRuntimeParams({ voiceChatActive: false }),
							);
						} else {
							voiceChat.start().catch((err: Error) => {
								addSystemMessage(`Voice chat error: ${err.message}`);
							});
							// Tell the agent voice chat is ON so it stops apologising for
							// being "text-only" — its replies will be spoken via TTS.
							import("../../../packages/ai/tools").then((m) =>
								m.setRuntimeParams({ voiceChatActive: true }),
							);
						}
					} else if (args[0] === "record" || args[0] === "listen" || args[0] === "stt") {
						voice.toggle().catch((err: Error) => {
							addSystemMessage(`Voice error: ${err.message}`);
						});
						addSystemMessage(
							voice.state === "recording"
								? "Voice recording stopped."
								: "Voice recording started. Speak now... (Ctrl+R to stop)",
						);
					} else if (args[0] === "status") {
						const setupInfo = voice.setupStatus;
						const backendLabel = voiceChat.backend ? ` [${voiceChat.backend}]` : "";
						const voiceChatStatus = voiceChat.isActive
							? `\nVoice Chat: Active (${voiceChat.state})${backendLabel}`
							: `\nVoice Chat: Inactive${backendLabel}`;
						const status = voice.isAvailable
							? `Voice: Available (model: ${voice.engine.getConfig().model || "base"})${voiceChatStatus}`
							: `Voice: Not available — ${setupInfo?.missing?.join(", ") || voice.errorMessage || "sox/whisper not found"}`;
						addSystemMessage(status);
					} else if (args[0] === "stop") {
						if (voiceChat.isActive) {
							voiceChat.stop();
						} else {
							addSystemMessage("Voice chat is not active.");
						}
					} else if (args[0] === "on" || args[0] === "off") {
						// /voice on|off - toggle TTS output for agent replies.
						// Persists to ~/.8gent/settings.json so the choice survives restarts.
						(async () => {
							const mod = await import(
								"../../../packages/settings/index.js"
							);
							const next = args[0] === "on";
							const cur = mod.loadSettings();
							mod.saveSettings({
								...cur,
								voice: { ...cur.voice, outputEnabled: next },
							});
							addSystemMessage(
								next
									? "TTS output enabled. Agent replies will be spoken."
									: "TTS output disabled. Agent replies will be silent.",
							);
						})().catch((err) => {
							addSystemMessage(
								`Could not update voice setting: ${
									err instanceof Error ? err.message : String(err)
								}`,
							);
						});
					} else {
						addSystemMessage(
							"Voice commands:\n" +
								"  /voice chat    — Start/stop voice conversation mode\n" +
								"  /voice record  — Toggle STT recording (or press Ctrl+R)\n" +
								"  /voice status  — Check voice system status\n" +
								"  /voice stop    — Stop voice chat mode\n" +
								"  /voice on|off  — Toggle TTS output",
						);
					}
					break;

				case "skills":
					void (async () => {
						try {
							const registry = await getSlashRegistry();
							const skills = getSkillSummary(registry);
							if (skills.length < 1) {
								addSystemMessage(
									"No skills loaded. Add .md under ~/.8gent/skills/ or run from a repo with .claude/skills/*/SKILL.md.",
								);
								return;
							}
							const lines = [
								`${skills.length} skills — type the slash command to run (same as injecting that skill prompt):`,
							];
							for (const skill of skills.slice(0, 45)) {
								const d =
									skill.description.length > 85
										? `${skill.description.slice(0, 82)}…`
										: skill.description;
								lines.push(`  /${skill.name} — ${d}`);
							}
							if (skills.length > 45) {
								lines.push(`  … and ${skills.length - 45} more`);
							}
							addSystemMessage(lines.join("\n"));
						} catch (e) {
							addSystemMessage(`Skills: ${e instanceof Error ? e.message : String(e)}`);
						}
					})();
					break;

				// Model selection - check if args provided
				default:
					// Handle /auth command
					if ((command as string) === "auth") {
						const sub = args[0] || "status";
						if (sub === "login") {
							addSystemMessage("Opening browser to sign in...");
							import("../../../packages/auth/cli-auth-server.js").then(({ runCLIAuthFlow }) => {
								runCLIAuthFlow("https://8gent.app", {
									onServerReady: () => {},
									onBrowserOpened: () => {},
									onWaiting: () => {},
									onTokenReceived: (result) => {
										if (result.success) {
											setAuthStatus("authenticated");
											setAuthUser({
												displayName: result.displayName || "User",
												plan: "free",
											});
											addSystemMessage(
												`Signed in as ${result.displayName || result.email || "User"}`,
											);

											// Set up GitHub integration silently (no messages)
											import("../../../packages/auth/github.js")
												.then(({ getGitHubAuth }) => {
													const gh = getGitHubAuth();
													if (result.token) {
														gh.storeToken(result.token);
														gh.configureGhCli(result.token).catch(() => {});
													}
													// Silently verify GitHub — no chat message
													gh.getUser().catch(() => {});
												})
												.catch(() => {});
										}
									},
									onTimeout: () => {
										addSystemMessage("Auth timed out. Try /auth login again.");
									},
									onError: (err) => {
										addSystemMessage(`Auth error: ${err}`);
									},
								}).catch(() => {
									addSystemMessage("Auth failed. Running in anonymous mode.");
								});
							});
						} else if (sub === "logout") {
							authManager?.logout?.();
							setAuthStatus("anonymous");
							setAuthUser(null);
							addSystemMessage("Logged out. Running in anonymous mode.");
						} else if (sub === "github") {
							// Show GitHub-specific info
							import("../../../packages/auth/github.js")
								.then(({ getGitHubAuth }) => {
									const gh = getGitHubAuth();
									Promise.all([gh.getUser(), gh.isGhCliAvailable(), gh.getToken()])
										.then(([user, ghCliAvailable, token]) => {
											import("../../../packages/auth/github-tools.js").then(
												({ getCurrentRepoInfo }) => {
													getCurrentRepoInfo().then((repoInfo) => {
														const lines = ["GitHub Integration:"];
														lines.push(`  Connected: ${token ? "Yes" : "No"}`);
														if (user) {
															lines.push(`  Username: @${user.username}`);
															lines.push(`  Name: ${user.name}`);
															lines.push(`  Profile: ${user.profileUrl}`);
														}
														lines.push(`  gh CLI: ${ghCliAvailable ? "Available" : "Not found"}`);
														if (repoInfo) {
															lines.push(`  Current repo: ${repoInfo.owner}/${repoInfo.repo}`);
														}
														addSystemMessage(lines.join("\n"));
													});
												},
											);
										})
										.catch(() => {
											addSystemMessage("GitHub: Not connected. Run /auth login first.");
										});
								})
								.catch(() => {
									addSystemMessage("GitHub module not available.");
								});
						} else {
							// Show general auth status + GitHub summary
							import("../../../packages/auth/github.js")
								.then(({ getGitHubAuth }) => {
									const gh = getGitHubAuth();
									gh.getUser()
										.then((ghUser) => {
											addSystemMessage(
												`Auth Status: ${authStatus}\n${
													authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : ""
												}${ghUser ? `GitHub: @${ghUser.username}\n` : ""}\nCommands: /auth login, /auth logout, /auth github`,
											);
										})
										.catch(() => {
											addSystemMessage(
												`Auth Status: ${authStatus}\n${
													authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : ""
												}\nCommands: /auth login, /auth logout, /auth github`,
											);
										});
								})
								.catch(() => {
									addSystemMessage(
										`Auth Status: ${authStatus}\n${
											authUser ? `User: ${authUser.displayName} (${authUser.plan})\n` : ""
										}\nCommands: /auth login, /auth logout, /auth github`,
									);
								});
						}
					}
					// Handle /github command
					if ((command as string) === "github") {
						const sub = args[0] || "status";

						if (authStatus !== "authenticated") {
							addSystemMessage("GitHub: Not authenticated. Run /auth login first.");
						} else {
							import("../../../packages/auth/github.js")
								.then(({ getGitHubAuth }) => {
									const gh = getGitHubAuth();
									gh.getToken()
										.then((token) => {
											if (!token) {
												addSystemMessage(
													"GitHub: No token available. Try /auth login to reconnect.",
												);
												return;
											}

											import("../../../packages/auth/github-tools.js").then((tools) => {
												if (sub === "repos") {
													tools
														.listRepos(token, { perPage: 15 })
														.then((repos) => {
															if (repos.length === 0) {
																addSystemMessage("No repositories found.");
																return;
															}
															const lines = ["Your repositories:"];
															for (const r of repos) {
																const badge = r.isPrivate ? "[private]" : "[public]";
																lines.push(`  ${badge} ${r.fullName}`);
															}
															addSystemMessage(lines.join("\n"));
														})
														.catch((err: Error) =>
															addSystemMessage(`GitHub error: ${err.message}`),
														);
												} else if (sub === "issues") {
													tools.getCurrentRepoInfo().then((info) => {
														if (!info) {
															addSystemMessage(
																"Not in a GitHub repository. Navigate to a repo directory first.",
															);
															return;
														}
														tools
															.listIssues(token, info.owner, info.repo)
															.then((issues) => {
																if (issues.length === 0) {
																	addSystemMessage(`No open issues in ${info.owner}/${info.repo}.`);
																	return;
																}
																const lines = [`Open issues in ${info.owner}/${info.repo}:`];
																for (const i of issues) {
																	const labels =
																		i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
																	lines.push(`  #${i.number} ${i.title}${labels}`);
																}
																addSystemMessage(lines.join("\n"));
															})
															.catch((err: Error) =>
																addSystemMessage(`GitHub error: ${err.message}`),
															);
													});
												} else if (sub === "pr") {
													tools.getCurrentRepoInfo().then((info) => {
														if (!info) {
															addSystemMessage("Not in a GitHub repository.");
															return;
														}
														tools.getCurrentBranch().then((branch) => {
															if (!branch || branch === "main" || branch === "master") {
																addSystemMessage(
																	"Switch to a feature branch before creating a PR.",
																);
																return;
															}
															tools
																.getDefaultBranch(token, info.owner, info.repo)
																.then((baseBranch) => {
																	const title = args.slice(1).join(" ") || `PR from ${branch}`;
																	tools
																		.createPR(token, info.owner, info.repo, {
																			title,
																			body: `Created via 8gent Code from branch \`${branch}\`.`,
																			head: branch,
																			base: baseBranch,
																		})
																		.then((pr) => {
																			if (pr) {
																				addSystemMessage(`PR #${pr.number} created: ${pr.url}`);
																			} else {
																				addSystemMessage(
																					"Failed to create PR. Push your branch first, or a PR may already exist.",
																				);
																			}
																		})
																		.catch((err: Error) =>
																			addSystemMessage(`GitHub error: ${err.message}`),
																		);
																});
														});
													});
												} else {
													// Default: show status
													Promise.all([
														gh.getUser(),
														gh.isGhCliAvailable(),
														tools.getCurrentRepoInfo(),
													])
														.then(([user, ghCli, repoInfo]) => {
															const lines = ["GitHub Status:"];
															if (user) {
																lines.push(`  User: @${user.username} (${user.name})`);
															} else {
																lines.push("  User: Not connected");
															}
															lines.push(`  gh CLI: ${ghCli ? "Available" : "Not installed"}`);
															if (repoInfo) {
																lines.push(`  Repo: ${repoInfo.owner}/${repoInfo.repo}`);
															}
															lines.push(
																"\nCommands: /github issues, /github pr [title], /github repos",
															);
															addSystemMessage(lines.join("\n"));
														})
														.catch(() => addSystemMessage("Failed to fetch GitHub status."));
												}
											});
										})
										.catch(() => addSystemMessage("GitHub: Failed to get token."));
								})
								.catch(() => addSystemMessage("GitHub module not available."));
						}
					}
					// Handle /deploy command - trigger Vercel deploy
					if ((command as string) === "deploy") {
						addSystemMessage("Detecting Vercel project...");
						import("../../../packages/tools/vercel.js")
							.then(({ vercelDetectProject, vercelDeploy }) => {
								vercelDetectProject()
									.then((projectId) => {
										if (!projectId) {
											addSystemMessage(
												"Could not detect Vercel project. Use /vercel projects to list them.",
											);
											return;
										}
										addSystemMessage(`Found project ${projectId}. Triggering deploy...`);
										vercelDeploy(projectId)
											.then((result) => {
												addSystemMessage(`Deploy result:\n${result}`);
											})
											.catch((err: Error) => addSystemMessage(`Deploy failed: ${err.message}`));
									})
									.catch((err: Error) =>
										addSystemMessage(`Project detection failed: ${err.message}`),
									);
							})
							.catch(() => addSystemMessage("Vercel tools not available."));
					}
					// Handle /vercel command
					if ((command as string) === "vercel") {
						const sub = args[0] || "status";
						import("../../../packages/tools/vercel.js")
							.then((vercel) => {
								if (sub === "projects") {
									vercel
										.vercelListProjects()
										.then((result: string) => {
											addSystemMessage(`Vercel Projects:\n${result}`);
										})
										.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
								} else if (sub === "status") {
									vercel
										.vercelDetectProject()
										.then((projectId: string | null) => {
											if (!projectId) {
												addSystemMessage("Could not detect project. Use /vercel projects.");
												return;
											}
											vercel
												.vercelGetDeployments(projectId, 3)
												.then((result: string) => {
													addSystemMessage(`Latest Deployments:\n${result}`);
												})
												.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
										})
										.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
								} else if (sub === "env") {
									vercel
										.vercelDetectProject()
										.then((projectId: string | null) => {
											if (!projectId) {
												addSystemMessage("Could not detect project. Use /vercel projects.");
												return;
											}
											vercel
												.vercelGetEnv(projectId)
												.then((result: string) => {
													addSystemMessage(`Environment Variables:\n${result}`);
												})
												.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
										})
										.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
								} else if (sub === "logs") {
									vercel
										.vercelDetectProject()
										.then((projectId: string | null) => {
											if (!projectId) {
												addSystemMessage("Could not detect project. Use /vercel projects.");
												return;
											}
											vercel
												.vercelGetDeployments(projectId, 1)
												.then((result: string) => {
													const data = JSON.parse(result);
													if (!data.deployments?.length) {
														addSystemMessage("No deployments found.");
														return;
													}
													const deployId = data.deployments[0].id;
													vercel
														.vercelGetDeploymentLogs(deployId)
														.then((logs: string) => {
															addSystemMessage(`Deployment Logs:\n${logs}`);
														})
														.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
												})
												.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
										})
										.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
								} else if (sub === "domains") {
									vercel
										.vercelDetectProject()
										.then((projectId: string | null) => {
											if (!projectId) {
												addSystemMessage("Could not detect project. Use /vercel projects.");
												return;
											}
											vercel
												.vercelListDomains(projectId)
												.then((result: string) => {
													addSystemMessage(`Domains:\n${result}`);
												})
												.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
										})
										.catch((err: Error) => addSystemMessage(`Failed: ${err.message}`));
								} else {
									addSystemMessage(
										"Vercel commands:\n" +
											"  /vercel status  - Show latest deployments\n" +
											"  /vercel env     - List environment variables\n" +
											"  /vercel logs    - Show recent deployment logs\n" +
											"  /vercel projects - List all projects\n" +
											"  /vercel domains - Show custom domains\n" +
											"  /deploy         - Trigger redeploy",
									);
								}
							})
							.catch(() => addSystemMessage("Vercel tools not available. Check VERCEL_TOKEN."));
					}
					// Handle /model command
					if (command === ("model" as any)) {
						if (args.length > 0) {
							// Direct model set: /model qwen2.5:14b
							const newModel = args.join(" ");
							// Accept any model name — Ollama models, custom fine-tunes, OpenRouter IDs
							setCurrentModel(newModel);
							addSystemMessage(`Model switched to: ${newModel}`);
						} else {
							// Show model selector
							setViewMode("model-select");
						}
					}
					// Handle /provider command
					else if (command === ("provider" as any)) {
						if (args.length > 0) {
							const newProvider = args[0].toLowerCase();
							const provider = availableProviders.find((p) => p.name === newProvider);
							if (provider) {
								setCurrentProvider(newProvider);
								addSystemMessage(`Provider switched to: ${provider.displayName}`);
							} else {
								addSystemMessage(
									`Unknown provider: ${newProvider}\nUse /provider to see available options.`,
								);
							}
						} else {
							// Show provider selector
							setViewMode("provider-select");
						}
					}
					// Handle /vision command
					else if (command === ("vision" as any)) {
						handleVisionCommand(args);
					}
					// Workspace tab commands
					else if (command === ("notes" as any)) {
						workspaceTabs.addTab("notes");
					} else if (command === ("ideas" as any)) {
						workspaceTabs.addTab("ideas");
					} else if (command === ("btw" as any)) {
						workspaceTabs.addTab("btw");
					} else if (command === ("questions" as any)) {
						workspaceTabs.addTab("questions");
					} else if (command === ("projects" as any)) {
						workspaceTabs.addTab("projects");
					} else if (command === ("terminal" as any)) {
						workspaceTabs.addTab("terminal", (args as any[])?.[0] || "Terminal");
					}
					break;
			}
		},
		[
			addSystemMessage,
			kanbanBoard,
			startTime,
			totalTokens,
			recentCommands,
			currentBranch,
			showAnimations,
			soundEnabled,
			exit,
			availableModels,
			availableProviders,
			infiniteModeActive,
			onboardingManager,
			showOnboarding,
			currentModel,
			currentProvider,
			designAgent,
			adhdMode,
			agent,
			orchestration,
			workspaceTabs,
		],
	);

	// Reset agent progress for a new request
	const resetAgentProgress = useCallback(() => {
		setActiveTool(null);
		setStepCount(0);
		setToolCount(0);
		setTotalTokens(0);
		setProcessingStage("planning");
		setStatus("thinking");
		setEvidenceSummary(null);
		clearActivity();
	}, []);

	// Generate predictions based on input
	const generatePredictions = useCallback((input: string) => {
		const inputLower = input.toLowerCase();
		const predictions: ProactiveStep[] = [];

		// Generate context-aware predictions
		if (inputLower.includes("fix") || inputLower.includes("bug")) {
			predictions.push({
				id: `pred-${Date.now()}-1`,
				description: "Run tests to verify fix",
				tool: "exec",
				input: { command: "npm test" },
				priority: 9,
				confidence: 0.85,
				category: "test",
				predictedAt: new Date(),
				basedOn: [],
			});
		}

		if (inputLower.includes("add") || inputLower.includes("create")) {
			predictions.push({
				id: `pred-${Date.now()}-2`,
				description: "Create test file for new feature",
				tool: "write_file",
				input: {},
				priority: 7,
				confidence: 0.7,
				category: "test",
				predictedAt: new Date(),
				basedOn: [],
			});
		}

		// Always add some general predictions
		predictions.push(
			{
				id: `pred-${Date.now()}-3`,
				description: "Search for related code",
				tool: "search_symbols",
				input: { query: input.split(" ").slice(0, 3).join(" ") },
				priority: 6,
				confidence: 0.6,
				category: "exploration",
				predictedAt: new Date(),
				basedOn: [],
			},
			{
				id: `pred-${Date.now()}-4`,
				description: "Commit changes",
				tool: "exec",
				input: { command: "git commit" },
				priority: 5,
				confidence: 0.5,
				category: "git",
				predictedAt: new Date(),
				basedOn: [],
			},
		);

		return predictions.sort((a, b) => b.confidence * b.priority - a.confidence * a.priority);
	}, []);

	// Generate avenues based on input
	const generateAvenues = useCallback((input: string): Avenue[] => {
		const inputLower = input.toLowerCase();
		const avenues: Avenue[] = [];

		if (inputLower.includes("fix") || inputLower.includes("bug") || inputLower.includes("error")) {
			avenues.push({
				id: `avenue-${Date.now()}-1`,
				name: "Fix Bug",
				description: `Debug and fix: ${input.slice(0, 30)}...`,
				probability: 0.8,
				category: "bugfix",
				triggers: ["fix", "bug", "error"],
				plan: {
					goal: "Fix the reported issue",
					steps: [
						{
							id: "1",
							description: "Search for error",
							tool: "search_symbols",
						},
						{ id: "2", description: "Get symbol details", tool: "get_symbol" },
						{ id: "3", description: "Apply fix", tool: "edit_file" },
					],
					estimatedTime: 120,
				},
			});
		}

		if (
			inputLower.includes("add") ||
			inputLower.includes("create") ||
			inputLower.includes("implement")
		) {
			avenues.push({
				id: `avenue-${Date.now()}-2`,
				name: "Implement Feature",
				description: `Build: ${input.slice(0, 30)}...`,
				probability: 0.7,
				category: "feature",
				triggers: ["add", "create", "implement"],
				plan: {
					goal: "Implement the new feature",
					steps: [
						{
							id: "1",
							description: "Search existing code",
							tool: "search_symbols",
						},
						{ id: "2", description: "Create new file", tool: "write_file" },
						{ id: "3", description: "Add tests", tool: "write_file" },
					],
					estimatedTime: 180,
				},
			});
		}

		// Always add exploration avenue
		avenues.push({
			id: `avenue-${Date.now()}-3`,
			name: "Explore Codebase",
			description: `Understand: ${input.slice(0, 30)}...`,
			probability: 0.5,
			category: "explore",
			triggers: ["show", "find", "where", "what"],
			plan: {
				goal: "Understand the relevant code",
				steps: [
					{ id: "1", description: "Get file outline", tool: "get_outline" },
					{ id: "2", description: "Search symbols", tool: "search_symbols" },
				],
				estimatedTime: 60,
			},
		});

		return avenues.sort((a, b) => b.probability - a.probability);
	}, []);

	// Handle command submission. Defaults to the active tab; pass `submitTabId`
	// explicitly to route a submission to a specific (potentially non-active)
	// tab. With per-tab agents, each tab id has its own queue + Agent + ESC
	// scope so concurrent submissions across Orchestrator / Engineer / QA do
	// not block one another.
	const handleSubmit = async (rawInput: string, submitTabId?: string) => {
		const tabId = submitTabId ?? activeTabId;
		const tabTitle = workspaceTabs.tabs.find((t) => t.id === tabId)?.title || "Chat";
		const { text: afterPaths, image: pastedNow } = imageInput.processInput(rawInput);
		const attached = pastedNow ?? imageInput.getAttachedImage();
		const input = afterPaths.trim();

		if (!input && !attached) return;

		// (gh auth LLM intercept removed — now handled as a deterministic gate in the UI)

		if (showOnboarding && !input && attached) {
			addSystemMessage(
				"Answer onboarding in text first. Your image is still in the input bar if you need it after setup.",
			);
			return;
		}

		if (pastedNow) {
			addSystemMessage(
				`Image ready: ${pastedNow.filename} (${(pastedNow.size / 1024).toFixed(1)} KB)`,
			);
		}

		const bubbleContent = input || (attached ? `[Image: ${attached.filename}]` : "");

		// Handle onboarding answers first
		if (showOnboarding && !afterPaths.trim().startsWith("/")) {
			// Track the answer for display
			setOnboardingSteps((prev) => {
				const updated = [...prev];
				const activeIdx = updated.findIndex((s) => s.status === "active");
				if (activeIdx >= 0) {
					updated[activeIdx] = {
						...updated[activeIdx],
						answer: input,
						status: "done" as const,
					};
				}
				return updated;
			});

			// Telegram token feedback
			if (/^\d+:/.test(input.trim())) {
				addSystemMessage("Telegram token received. Your bot will activate on next launch.");
				// Speak confirmation (gated by voice.outputEnabled)
				speakOnboardingLine("Telegram bot token saved. Brilliant.");
			}

			const result = onboardingManager.processAnswer(input);
			if (result.success) {
				if (result.nextQuestion) {
					applyOnboardingQuestion(result.nextQuestion);
					setOnboardingStepIndex((prev) => prev + 1);
					setOnboardingSteps((prev) => [
						...prev,
						{
							question: result.nextQuestion?.question ?? "",
							status: "active" as const,
						},
					]);
					// Speak each question aloud during onboarding (gated by voice.outputEnabled)
					{
						const voice = onboardingManager.getUser()?.preferences?.voice?.voiceId;
						speakOnboardingLine(result.nextQuestion.question, voice);
					}
				} else {
					// Onboarding complete
					setShowOnboarding(false);
					setOnboardingSelectChoices(null);
					setOnboardingProviderCheck(null);
					setOnboardingAgentDefault(null);
					setViewMode("chat");
					const user = onboardingManager.getUser();
					const name = user.identity.name || "friend";
					addSystemMessage(
						`Welcome, ${name}. I now understand you ${Math.round(user.understanding.confidenceScore * 100)}%.\nLet's build something magnificent.`,
					);
					// Speak the welcome (gated by voice.outputEnabled)
					{
						const voice = user.preferences?.voice?.voiceId;
						speakOnboardingLine(
							`Welcome ${name}. Let's build something magnificent.`,
							voice,
						);
					}

					// Apply user preferences to current session
					if (user.preferences.model.provider) {
						setCurrentProvider(user.preferences.model.provider);
					}
					if (user.preferences.model.default) {
						setCurrentModel(user.preferences.model.default);
					}
				}
			} else {
				addSystemMessage("I didn't quite catch that. Please try again.");
			}
			return;
		}

		// Track command history
		setRecentCommands((prev) => [bubbleContent, ...prev].slice(0, 20));

		// Add user message to the target tab's history. If submitting on a
		// non-active tab (future feature), this still streams correctly.
		const userMsgId = `user-${Date.now()}`;
		appendToTab(tabId, {
			id: userMsgId,
			role: "user" as const,
			content: bubbleContent,
			timestamp: new Date(),
		});
		// Track in session tree
		sessionTreeRef.current.addMessage(sessionTreeRef.current.tipId, "user", bubbleContent);
		// Session logger: user message
		logMessage(tabId, tabTitle, "user", bubbleContent);

		// Auto-kanban: create a card for this user message
		autoKanban.onUserMessage(tabId, tabTitle, bubbleContent);

		// If THIS tab's agent is already running, queue this message on that
		// tab's queue. Other tabs are unaffected.
		if (isAgentRunningOnTab(tabId)) {
			const q = messageQueuesRef.current.get(tabId) ?? [];
			q.push(bubbleContent);
			messageQueuesRef.current.set(tabId, q);
			addSystemMessage("Queued — will send after current task completes.");
			return;
		}

		// Run the agent for the captured tab id. All state updates, agent
		// lookups, and event side-effects scope to `tabId` so concurrent
		// submissions across tabs don't clobber each other.
		const runAgent = async (message: string) => {
			setAgentRunningOnTab(tabId, true);
			perTabAgents.setTabProcessing(tabId, true);
			// Foreground-only resets - if the user submitted on the active tab,
			// reset the per-tab progress meters. If they submitted on a
			// background tab (future), leave the foreground UI alone.
			if (tabId === activeTabId) {
				resetAgentProgress();
				setTvTasks([]);
				setNarratorText("Thinking...");
			}

			const cmdStartTime = Date.now();
			const messageForAgent = await expandSkillSlashCommand(message);
			const routeHint = messageForAgent.trim() || "User attached an image.";

			// External-agent divert: if the target tab was spawned via /spawn,
			// hand the prompt to the nested CLI (claude / codex / hermes / etc.)
			// instead of our own agent loop. Conversation history is replayed
			// each turn since v1 is one-shot.
			const targetTab = workspaceTabs.tabs.find((t) => t.id === tabId);
			const targetTabData = targetTab?.data as
				| { externalAgent?: { presetId: string } }
				| undefined;
			if (targetTabData?.externalAgent) {
				const preset = getPreset(targetTabData.externalAgent.presetId);
				if (!preset) {
					addSystemMessage(
						`[external-agent] Unknown preset "${targetTabData.externalAgent.presetId}". Run /spawn with one of: ${listPresetIds().join(", ")}`,
					);
					setAgentRunningOnTab(tabId, false);
					perTabAgents.setTabProcessing(tabId, false);
					return;
				}
				if (tabId === activeTabId) setNarratorText(`Spawning ${preset.label}...`);
				// Pull this tab's messages from the per-tab buffer (or the
				// foreground state if it's the active tab).
				const tabMessages =
					tabId === activeTabId ? messages : tabMessagesRef.current.get(tabId) ?? [];
				const history = tabMessages
					.filter((m) => m.role === "user" || m.role === "assistant")
					.map((m) => ({ role: m.role, content: m.content }));
				const composed = composePrompt(history, messageForAgent);
				const result = await runExternalAgent(preset, composed);

				if (result.ok && result.text) {
					appendToTab(tabId, {
						id: `assistant-${Date.now()}`,
						role: "assistant" as const,
						content: result.text,
						timestamp: new Date(),
					});
					{
						const targetTabRole = (
							workspaceTabs.tabs.find((t) => t.id === tabId)?.data as
								| { role?: string }
								| undefined
						)?.role;
						speakAgentReply(targetTabRole, result.text);
					}
				} else {
					appendToTab(tabId, {
						id: `system-ext-${Date.now()}`,
						role: "system" as const,
						content: `[${preset.label}] ${result.error || "no output"}\n\nCommand: ${result.command}\nDuration: ${result.durationMs}ms${
							result.exitCode !== null && result.exitCode !== undefined
								? ` (exit ${result.exitCode})`
								: ""
						}`,
						timestamp: new Date(),
					});
				}

				setAgentRunningOnTab(tabId, false);
				perTabAgents.setTabProcessing(tabId, false);
				if (tabId === activeTabId) setNarratorText("");
				return;
			}

			// Foreground-only: kanban / avenues only reset on active tab.
			if (tabId === activeTabId) {
				const newPredictions = generatePredictions(routeHint);
				setPredictedSteps(newPredictions);
				setPlanNextStep(newPredictions[0]?.description || null);
				const newAvenues = generateAvenues(routeHint);
				setAvenues(newAvenues);
				setKanbanBoard((prev) => ({
					...prev,
					ready: newPredictions.slice(0, 3) as any,
					backlog: newPredictions.slice(3) as any,
				}));
			}

			if (!currentModel) {
				appendToTab(tabId, {
					id: `system-no-model-${Date.now()}`,
					role: "system" as const,
					content:
						"[No model available] No Ollama models detected.\n" +
						"Pull a model first: ollama pull qwen3:14b\n" +
						"Or switch provider with /provider",
					timestamp: new Date(),
				});
				setAgentRunningOnTab(tabId, false);
				perTabAgents.setTabProcessing(tabId, false);
				return;
			}

			// Look up this tab's Agent. For the active tab the cached `agent`
			// state already mirrors it; for any other tab, fetch from the
			// per-tab map.
			const targetAgent =
				tabId === activeTabId ? agent : perTabAgents.getAgent(tabId);
			const targetReady = tabId === activeTabId ? agentReady : Boolean(targetAgent);

			if (targetAgent && targetReady) {
				try {
					// Task Router: classify and potentially switch model. Only
					// applies to active tab to avoid surprising background tabs.
					if (tabId === activeTabId) {
						const router = getTaskRouter();
						const routerConfig = router.getConfig();
						if (routerConfig.enabled) {
							try {
								const decision = await router.route(routeHint);
								if (
									decision.model !== currentModel &&
									decision.confidence >= routerConfig.confidenceThreshold
								) {
									setCurrentModel(decision.model);
									addSystemMessage(
										`Routed to ${decision.model} (${decision.category}, ${(decision.confidence * 100).toFixed(0)}%)`,
									);
								}
							} catch {
								// Router failed silently
							}
						}
					}

					// Inject agent mode context into the message
					const modePrefix = agentMode !== "Planning" ? `[Mode: ${agentMode}] ` : "";
					const img = imageInput.getAttachedImage();
					const chatPromise = targetAgent.chat(
						modePrefix + messageForAgent.trim(),
						img?.base64,
						img?.mimeType,
					);
					// Track for Ctrl+G background-divert (per tab).
					perTabAgents.trackPromise(tabId, chatPromise, messageForAgent.trim());
					let reply: string;
					try {
						reply = await chatPromise;
					} catch (err) {
						// If backgrounded mid-flight, swallow: the pool surfaces errors.
						if (perTabAgents.getPromise(tabId) !== chatPromise) return;
						throw err;
					}
					// If the user pressed Ctrl+G while this was in flight, the
					// background pool has taken ownership. Don't also stamp the
					// result onto the (now-stale) foreground tab.
					if (perTabAgents.getPromise(tabId) !== chatPromise) {
						return;
					}
					perTabAgents.clearPromise(tabId);
					const trimmed = (reply ?? "").trim();
					if (trimmed) {
						appendToTab(tabId, {
							id: `assistant-${Date.now()}`,
							role: "assistant" as const,
							content: trimmed,
							timestamp: new Date(),
						});
						{
							const targetTabRole = (
								workspaceTabs.tabs.find((t) => t.id === tabId)?.data as
									| { role?: string }
									| undefined
							)?.role;
							speakAgentReply(targetTabRole, trimmed);
						}
					}
					// appendClosingQuestionIfNeeded reads the just-appended buffer
					// and decides whether to add a follow-up bubble.
					{
						const cur = tabMessagesRef.current.get(tabId) ?? [];
						const after = appendClosingQuestionIfNeeded(cur);
						if (after !== cur) {
							tabMessagesRef.current.set(tabId, after);
							if (tabId === activeTabId) setMessagesRaw(after);
						}
					}
					// Clear image after sending
					if (img) imageInput.removeImage();
					const treePreview = (reply ?? "").trim().slice(0, 160) || "(tools only)";
					sessionTreeRef.current.addMessage(sessionTreeRef.current.tipId, "assistant", treePreview);
					if (tabId === activeTabId) {
						setLastResponseTime(Date.now() - cmdStartTime);
						setStatus("success");
						if (soundEnabled) playSound("success");
					}
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					logError(tabId, tabTitle, errorMsg);
					appendToTab(tabId, {
						id: `assistant-error-${Date.now()}`,
						role: "assistant" as const,
						content: `[Error] ${errorMsg}`,
						timestamp: new Date(),
					});
					if (tabId === activeTabId) {
						setStatus("error");
						setTimeout(() => setStatus("idle"), 3000);
					}
				}
			} else {
				// Mock mode (per tab)
				setTimeout(
					() => {
						appendToTab(tabId, {
							id: `assistant-${Date.now()}`,
							role: "assistant" as const,
							content: generateResponse(messageForAgent),
							timestamp: new Date(),
						});
						if (tabId === activeTabId) {
							setLastResponseTime(Date.now() - cmdStartTime);
							setStatus("success");
							if (soundEnabled) playSound("success");
							setTimeout(() => setStatus("idle"), 1500);
						}
					},
					800 + Math.random() * 400,
				);
			}

			perTabAgents.setTabProcessing(tabId, false);
			if (tabId === activeTabId) {
				setActiveTool(null);
			}
			setAgentRunningOnTab(tabId, false);

			// Process queued messages for THIS tab only.
			const q = messageQueuesRef.current.get(tabId) ?? [];
			if (q.length > 0) {
				const next = q.shift()!;
				messageQueuesRef.current.set(tabId, q);
				appendToTab(tabId, {
					id: `user-queued-${Date.now()}`,
					role: "user" as const,
					content: next,
					timestamp: new Date(),
				});
				setTimeout(() => runAgent(next), 100);
			} else if (tabId === activeTabId) {
				setTimeout(() => setStatus("idle"), 1500);
			}
		};

		runAgent(input);
	};

	// Helper to close tab-based views (switch back to first chat tab)
	const closeTabView = () => {
		const chatTab = workspaceTabs.tabs.find((t) => t.type === "chat");
		if (chatTab) workspaceTabs.switchTab(chatTab.id);
	};

	// Render main content based on view mode + active tab type
	const renderMainContent = () => {
		// Tab-driven views: when viewMode is "chat", check if the active tab is a utility tab
		if (viewMode === "chat" && activeTabType !== "chat") {
			switch (activeTabType) {
				case "notes":
					return (
						<NotesView
							visible={true}
							data={workspaceTabs.activeTab?.data || {}}
							onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
							onClose={closeTabView}
							chatTabNames={workspaceTabs.getTabsByType("chat").map((t) => t.title)}
							onSendToChat={(content) => {
								// Switch to first chat tab and add as user message
								const chatTabs = workspaceTabs.getTabsByType("chat");
								if (chatTabs.length > 0) {
									workspaceTabs.switchTab(chatTabs[0].id);
									addSystemMessage(
										`[From Notes] ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
									);
								}
							}}
						/>
					);
				case "ideas":
					return (
						<IdeasView
							visible={true}
							data={workspaceTabs.activeTab?.data || {}}
							onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
							onClose={closeTabView}
						/>
					);
				case "btw":
					return (
						<BTWView
							visible={true}
							data={workspaceTabs.activeTab?.data || {}}
							onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
							onClose={closeTabView}
						/>
					);
				case "questions":
					return (
						<QuestionsView
							visible={true}
							data={workspaceTabs.activeTab?.data || {}}
							onUpdateData={(d) => workspaceTabs.updateTabData(workspaceTabs.activeTab.id, d)}
							onClose={closeTabView}
						/>
					);
				case "projects":
					return (
						<ProjectsView
							visible={true}
							onClose={closeTabView}
							currentPath={projectCwd}
							onSwitchProject={(path) => {
								try {
									process.chdir(path);
									setProjectCwd(path);
									closeTabView();
									addSystemMessage(`Working directory: ${path}`);
								} catch (e) {
									addSystemMessage(
										`Could not switch project: ${e instanceof Error ? e.message : String(e)}`,
									);
								}
							}}
						/>
					);
				case "kanban":
					return autoKanban.stats.total > 0 ? (
						<AutoPlanKanban
							columns={autoKanban.columns}
							stats={autoKanban.stats}
							visible={true}
							onClose={closeTabView}
							compact={false}
						/>
					) : (
						<PlanKanban
							board={kanbanBoard as any}
							visible={true}
							onClose={closeTabView}
							compact={false}
						/>
					);
				case "music":
					return (
						<MusicPlayerView
							visible={true}
							isPlaying={getADHDAudio().isPlaying}
							currentTrack={getADHDAudio().current}
							duration={getADHDAudio().config.duration}
							onPlay={(soundscape) => {
								const audio = getADHDAudio();
								audio.onProgress = (msg) => addSystemMessage(msg);
								audio.play(soundscape as any).then((r) => {
									addSystemMessage(r.message);
									audio.onProgress = null;
								});
							}}
							onPlayFile={(filePath) => {
								const audio = getADHDAudio();
								const result = audio.playFile(filePath);
								addSystemMessage(result.message);
							}}
							onStop={() => {
								getADHDAudio().stop();
								addSystemMessage("Music stopped.");
							}}
							onClose={closeTabView}
							onGenerate={(prompt) => {
								addSystemMessage(`Custom gen: "${prompt}" — use /music gen ${prompt}`);
								closeTabView();
							}}
						/>
					);
				case "terminal":
					return (
						<TerminalView
							tabId={workspaceTabs.activeTab?.id || "terminal-default"}
							cwd={projectCwd}
							visible={true}
							onClose={closeTabView}
						/>
					);
				case "settings":
					return <SettingsView visible={true} onClose={closeTabView} />;
			}
		}

		switch (viewMode) {
			case "kanban":
				return autoKanban.stats.total > 0 ? (
					<AutoPlanKanban
						columns={autoKanban.columns}
						stats={autoKanban.stats}
						visible={true}
						onClose={() => setViewMode("chat")}
						compact={false}
					/>
				) : (
					<PlanKanban
						board={kanbanBoard as any}
						visible={true}
						onClose={() => setViewMode("chat")}
						compact={false}
					/>
				);

			case "avenues":
				return (
					<AvenueDisplay
						avenues={avenues as any}
						visible={true}
						onAvenueSelect={() => setViewMode("chat")}
					/>
				);

			case "predict":
				return (
					<PredictedSteps
						steps={predictedSteps as any}
						visible={true}
						onStepAccept={(id) => {
							// Move step to in progress
							setKanbanBoard((prev) => {
								const step =
									prev.ready.find((s) => s.id === id) || prev.backlog.find((s) => s.id === id);
								if (!step) return prev;
								return {
									...prev,
									ready: prev.ready.filter((s) => s.id !== id),
									backlog: prev.backlog.filter((s) => s.id !== id),
									inProgress: [...prev.inProgress, step],
								};
							});
						}}
					/>
				);

			case "model-select":
				return modelsLoading ? (
					<Box flexDirection="column" padding={1}>
						<AppText bold>Fetching models from {currentProvider}...</AppText>
					</Box>
				) : (
					<ModelSelector
						models={availableModels}
						currentModel={currentModel}
						onSelect={(model) => {
							setCurrentModel(model);
							addSystemMessage(`Model switched to: ${model}`);
							setViewMode("chat");
						}}
						onCancel={() => setViewMode("chat")}
						provider={currentProvider}
					/>
				);

			case "provider-select":
				return (
					<ProviderSelector
						providers={availableProviders}
						currentProvider={currentProvider}
						onSelect={(provider) => {
							setCurrentProvider(provider);
							const p = availableProviders.find((pr) => pr.name === provider);
							addSystemMessage(`Provider switched to: ${p?.displayName || provider}`);
							setViewMode("chat");
						}}
						onCancel={() => setViewMode("chat")}
					/>
				);

			case "onboarding":
				return (
					<OnboardingScreen
						steps={onboardingSteps}
						currentQuestion={currentOnboardingQuestion || ""}
						stepIndex={onboardingStepIndex}
						// totalSteps reads from the manager so the indicator stays accurate
						// when questions are added/removed without code churn.
						totalSteps={
							onboardingTotalSteps > 0
								? onboardingTotalSteps
								: onboardingManager.getTotalSteps()
						}
						userName={onboardingManager.getUser()?.identity?.name || undefined}
						agentName={
							(onboardingManager.getUser()?.preferences?.voice as any)?.agentName || undefined
						}
						selectChoices={onboardingSelectChoices ?? undefined}
						onSelect={
							onboardingSelectChoices ? (value: string) => handleSubmit(value) : undefined
						}
						providerCheck={onboardingProviderCheck ?? undefined}
						onProviderResolve={
							onboardingProviderCheck
								? (result: "live" | "skip") => handleSubmit(result)
								: undefined
						}
						agentNameDefault={onboardingAgentDefault ?? undefined}
					/>
				);

			case "animations":
				// Animation showcase/gallery
				return (
					<AnimationShowcase animation={currentAnimation} onClose={() => setViewMode("chat")} />
				);

			case "design":
				// Design system selector
				return (
					<DesignSuggestionPanel
						intro={designIntro}
						suggestions={designSuggestions.map((s) => ({
							id: s.id,
							name: s.name,
							description: s.description,
							reasoning: s.reasoning,
							score: s.score,
							stack: s.stack,
							preview: s.preview,
						}))}
						followUp="Which direction speaks to you? (1, 2, or 3)"
						onSelect={(option) => {
							designAgent.selectDesign(option.id).then((result) => {
								if (result.success && result.selectedDesign) {
									setSelectedDesign(result.selectedDesign);
									addSystemMessage(
										`\u2713 Design selected: **${result.selectedDesign.name}**\n\nStack: ${result.selectedDesign.stack.join(", ")}\n\n${
											result.commands.length > 0
												? `Setup commands:\n${result.commands.map((c) => `  $ ${c}`).join("\n")}\n\n`
												: ""
										}I'll use this design system for the implementation.`,
									);
								}
								setViewMode("chat");
							});
						}}
						onSkip={() => {
							addSystemMessage("Skipping design selection. I'll pick something sensible.");
							setViewMode("chat");
						}}
						visible={true}
					/>
				);

			case "music":
				return (
					<MusicPlayerView
						visible={true}
						isPlaying={getADHDAudio().isPlaying}
						currentTrack={getADHDAudio().current}
						duration={getADHDAudio().config.duration}
						onPlay={(soundscape) => {
							const audio = getADHDAudio();
							audio.onProgress = (msg) => addSystemMessage(msg);
							audio.play(soundscape as any).then((r) => {
								addSystemMessage(r.message);
								audio.onProgress = null;
							});
						}}
						onPlayFile={(filePath) => {
							const audio = getADHDAudio();
							const result = audio.playFile(filePath);
							addSystemMessage(result.message);
						}}
						onStop={() => {
							getADHDAudio().stop();
							addSystemMessage("Music stopped.");
						}}
						onClose={() => setViewMode("chat")}
						onGenerate={(prompt) => {
							addSystemMessage(`Custom gen: "${prompt}" — use /music gen ${prompt}`);
							setViewMode("chat");
						}}
					/>
				);
			default:
				// Voice chat mode: minimal render to avoid Ink repaint collisions
				// (audio level + timer + message updates all fire simultaneously → ghost text)
				if (voiceChat.isActive) {
					const voiceMessages = messages
						.filter((m) => m.role === "user" || m.role === "assistant")
						.slice(-8);
					return (
						<Stack minHeight={0} flexGrow={1}>
							<Box paddingX={1} paddingY={1} flexDirection="column" gap={1}>
								<AppText color="cyan" bold>
									🎙 Voice Chat —{" "}
									{voiceChat.state === "listening"
										? "Listening..."
										: voiceChat.state === "transcribing"
											? "Transcribing..."
											: voiceChat.state === "speaking"
												? "Speaking..."
												: voiceChat.state === "thinking"
													? "Thinking..."
													: "Ready"}
								</AppText>
								{voiceMessages.map((m) => (
									<Box key={m.id} flexDirection="column">
										<MutedText>{m.role === "user" ? "You:" : "Agent:"}</MutedText>
										<AppText wrap="wrap">{(m.content || "").slice(0, 400)}</AppText>
									</Box>
								))}
							</Box>
						</Stack>
					);
				}

				// TV Mode: show task cards when agent is using tools
				// Fall back to message list for text-only conversation
				if (tvTasks.length > 0) {
					return (
						<NarratorView
							tasks={tvTasks}
							narratorText={narratorText}
							maxHeight={Math.max(viewport.height - 12, 10)}
						/>
					);
				}
				return (
					<Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
						<MessageList
							messages={messages}
							animateTyping={showAnimations}
							showAnimations={showAnimations}
							soundEnabled={soundEnabled}
							contentWidth={chatContentWidth}
							maxVisible={Math.max(5, viewport.height - 10)}
						/>
						{isProcessing && (
							<ActivityMonitor
								activeTool={activeTool}
								stepCount={stepCount}
								toolCount={toolCount}
								processingStage={processingStage}
								showAnimations={showAnimations}
							/>
						)}
					</Box>
				);
		}
	};

	const PROCESS_DETAIL_CHROME_ROWS = 10;

	if (introVisible) {
		return (
			<ADHDModeContext.Provider value={{ enabled: adhdMode, ratio: 0.5 }}>
				<FixedFrame>
					<IntroBanner onDone={() => setIntroVisible(false)} />
				</FixedFrame>
			</ADHDModeContext.Provider>
		);
	}

	return (
		<ADHDModeContext.Provider value={{ enabled: adhdMode, ratio: 0.5 }}>
			<FixedFrame>
				{/* Header */}
				<Box flexShrink={0}>
					{fancyHeader ? (
						<FancyHeader isProcessing={isProcessing} />
					) : (
						<Header
							isProcessing={isProcessing}
							showAnimations={showAnimations}
							updateAvailable={updateInfo}
						/>
					)}
				</Box>

				{/* Workspace tab bar - shows an inline busy indicator on each tab
				    whose Agent has an in-flight chat() call so the user can see
				    parallel work even while looking at a different tab. */}
				<Box flexShrink={0}>
					<TabBar
						tabs={workspaceTabs.tabs}
						onSwitch={workspaceTabs.switchTab}
						isTabProcessing={perTabAgents.isTabProcessing}
					/>
				</Box>

				{/* Main content area with folder frame */}
				<Box flexDirection="row" flexGrow={1} minHeight={0}>
					{/* Left border */}
					<Box flexDirection="column">
						<AppText color="cyan">│</AppText>
					</Box>
					{/* Main content (chat / kanban / etc.) or process detail */}
					<Box flexDirection="column" flexGrow={1} paddingX={1} minHeight={0} overflow="hidden">
						{processPanel.detailTaskId &&
						processPanel.tasks.find((t) => t.id === processPanel.detailTaskId) ? (
							<ProcessDetailView
								task={processPanel.tasks.find((t) => t.id === processPanel.detailTaskId)!}
								output={processPanel.detailOutput}
								onClose={processPanel.closeDetail}
								onKill={() => {
									const killed = processPanel.killSelected();
									if (killed) {
										setMessages((prev) => [
											...prev,
											{
												id: `system-kill-${Date.now()}`,
												role: "system" as const,
												content: `Process killed: "${killed.command.slice(0, 60)}"`,
												timestamp: new Date(),
											},
										]);
									}
								}}
								height={Math.max(10, viewport.height - PROCESS_DETAIL_CHROME_ROWS)}
							/>
						) : (
							renderMainContent()
						)}
					</Box>
					{/* Right border */}
					{!processPanel.sidebarOpen && (
						<Box flexDirection="column">
							<AppText color="cyan">│</AppText>
						</Box>
					)}

					{/* Right: process sidebar */}
					{processPanel.sidebarOpen && (
						<ProcessSidebar
							tasks={processPanel.tasks}
							selectedIndex={processPanel.selectedIndex}
							focused={processPanel.focusZone === "sidebar"}
							taskCounts={processPanel.taskCounts}
							width={processSidebarWidth}
							onNext={processPanel.nextTask}
							onPrev={processPanel.prevTask}
							onOpen={processPanel.openDetail}
							onKill={() => {
								const killed = processPanel.killSelected();
								if (killed) {
									setMessages((prev) => [
										...prev,
										{
											id: `system-kill-${Date.now()}`,
											role: "system" as const,
											content: `Process killed: "${killed.command.slice(0, 60)}"`,
											timestamp: new Date(),
										},
									]);
								}
							}}
							onUnfocus={processPanel.focusInput}
						/>
					)}

					{/* Right: background jobs panel (Ctrl+J) */}
					{bgPanelOpen && (
						<BackgroundPanel
							tasks={bgTasks}
							onClose={() => {
								setBgPanelOpen(false);
								setBgBanner(null);
							}}
							width={Math.min(48, Math.max(36, processSidebarWidth))}
						/>
					)}
				</Box>

				{/* Mini kanban removed — full board available via Ctrl+K */}

				{/* Status verb - only shown while processing (idle hides to recover 2 rows) */}
				{isProcessing && (
					<Box paddingX={1} flexShrink={0} width={Math.max(20, viewport.width - 4)}>
						<AnimatedStatusVerb
							type={processingStage === "planning" ? "planning" : "executing"}
							showIcon={true}
							active={true}
							maxWidth={Math.max(16, viewport.width - 10)}
						/>
					</Box>
				)}

				{/* Image attachment indicator */}
				{imageInput.currentImage && (
					<Box paddingX={1} flexShrink={0}>
						<ImageBadge image={imageInput.currentImage} onRemove={imageInput.removeImage} />
					</Box>
				)}

				{/* Background task completion banner (non-modal, no animation) */}
				{bgBanner && (
					<Box paddingX={1} flexShrink={0}>
						<AppText color="cyan">[bg] </AppText>
						<AppText>{bgBanner}</AppText>
					</Box>
				)}

				{/* Top separator line */}
				<Box paddingX={1} flexShrink={0}>
					<Divider />
				</Box>

				{/* Input section with context window display */}
				<Box paddingX={1} justifyContent="space-between" alignItems="center" flexShrink={0}>
					{/* Left: Context used */}
					<Box minWidth={tokenMeterColWidth} width={tokenMeterColWidth}>
						<MutedText>{formatTokens(totalTokens)}</MutedText>
					</Box>

					{/* Center: Command input */}
					<Box flexGrow={1} minWidth={6}>
						<CommandInput
							onSubmit={handleSubmit}
							isProcessing={isProcessing}
							focused={
								(viewMode === "chat" && activeTabType === "chat") ||
								(viewMode === "onboarding" && !onboardingSelectChoices)
							}
							processingStage={processingStage}
							showAnimations={showAnimations}
							activeTool={activeTool}
							stepCount={stepCount}
							toolCount={toolCount}
							totalTokens={totalTokens}
							isGitRepo={isGitRepo}
							currentBranch={currentBranch}
							planNextStep={planNextStep}
							recentCommands={recentCommands}
							onSlashCommand={handleSlashCommand}
							injectedText={voiceTranscript}
							transformInputValue={transformChatInput}
							allowEmptySubmit={!!imageInput.currentImage}
						/>
					</Box>

					{/* Right: Context max */}
					<Box minWidth={tokenMeterColWidth} width={tokenMeterColWidth} justifyContent="flex-end">
						<MutedText>/{formatTokens(contextMax)}</MutedText>
					</Box>
				</Box>

				{/* Bottom separator line */}
				<Box paddingX={1} flexShrink={0}>
					<Divider />
				</Box>

				{/* Expanded view panel (Ctrl+O) */}
				{expandedView && (
					<Box
						flexDirection="column"
						paddingX={1}
						borderStyle="single"
						borderColor="cyan"
						marginX={1}
						marginTop={1}
					>
						<Heading>∞ Extended Info</Heading>
						<Box marginTop={1} flexDirection="column">
							<MutedText>
								Model: <AppText color="cyan">{currentModel}</AppText> via{" "}
								<AppText color="magenta">{currentProvider}</AppText>
							</MutedText>
							<MutedText>
								Agent:{" "}
								<AppText color={agentReady ? "green" : "red"}>
									{agentReady ? "ready" : "not connected"}
								</AppText>
							</MutedText>
							<MutedText>
								Tokens:{" "}
								<AppText color="cyan">
									{totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}k` : "—"}
								</AppText>{" "}
								· Steps: <AppText color="cyan">{stepCount}</AppText> · Tools:{" "}
								<AppText color="cyan">{toolCount}</AppText>
							</MutedText>
							<MutedText>
								Response time:{" "}
								<AppText color="yellow">
									{lastResponseTime ? `${(lastResponseTime / 1000).toFixed(1)}s` : "—"}
								</AppText>
							</MutedText>
							{currentBranch && (
								<MutedText>
									Branch: <AppText color="yellow">{currentBranch}</AppText>
								</MutedText>
							)}
							<MutedText>
								Infinite:{" "}
								<AppText color={infiniteModeActive ? "red" : "green"}>
									{infiniteModeActive ? "∞ enabled" : "disabled"}
								</AppText>
							</MutedText>
						</Box>
						<Box marginTop={1}>
							<MutedText>Press Ctrl+O to close</MutedText>
						</Box>
					</Box>
				)}

				{/* HUD music player — only renders when DJ has a track loaded */}
				<Box flexShrink={0}>
					<HudMusicPlayer />
				</Box>

				{/* Status bar */}
				<Box flexShrink={0}>
					{showEnhancedStatus ? (
						<EnhancedStatusBar
							modelName={currentModel}
							runningAgents={providerHealth.live}
							totalAgents={providerHealth.total}
							permissionMode={infiniteModeActive ? "infinite" : "ask"}
							tokensSaved={totalTokens}
							currentBranch={currentBranch}
							startTime={startTime}
							planStatus={
								isProcessing
									? activeTool
										? "executing"
										: "planning"
									: stepCount > 0
										? "completed"
										: "idle"
							}
							planStepsCompleted={toolCount}
							planStepsTotal={stepCount}
							showAnimations={showAnimations}
							adhdMode={adhdMode}
							authStatus={authStatus}
							authUser={authUser}
							voiceState={(() => {
								const raw = voiceChat.isActive ? voiceChat.state : voice.state;
								return raw === "error" ? "idle" : raw;
							})()}
							voiceEnabled={Boolean(voice.isAvailable)}
							voiceChatActive={voiceChat.isActive}
						/>
					) : (
						<StatusBar
							tokensSaved={totalTokens}
							status={status}
							showAnimations={showAnimations}
							soundEnabled={soundEnabled}
						/>
					)}
				</Box>

				{/* Agent mode — iOS segmented control.
				    Active: ◆ + bold brand color. Inactive: ○ + muted. Dot carries state,
				    label gives semantics, hint defers to the right edge. */}
				<Box
					paddingX={1}
					marginTop={1}
					flexDirection="row"
					justifyContent="space-between"
					alignItems="center"
					flexShrink={0}
					overflow="hidden"
				>
					{compactAgentModeBar ? (
						<Box flexDirection="row" overflow="hidden" flexShrink={1}>
							<AppText color="cyan" bold wrap="truncate-end">{`\u25C6 ${agentMode}`}</AppText>
							<MutedText wrap="truncate-end">{"   \u2303T cycle"}</MutedText>
							{!processPanel.sidebarOpen && <ProcessBadge counts={processPanel.taskCounts} />}
						</Box>
					) : (
						<>
							<Box flexDirection="row" overflow="hidden" flexShrink={1}>
								{AGENT_MODES.map((mode, idx) => {
									const isActive = agentMode === mode;
									return (
										<Box key={mode} flexShrink={0} flexDirection="row">
											{idx > 0 && <MutedText>{"   "}</MutedText>}
											{isActive ? (
												<AppText color="cyan" bold>{`\u25C6 ${mode}`}</AppText>
											) : (
												<MutedText>{`\u25CB ${mode}`}</MutedText>
											)}
										</Box>
									);
								})}
							</Box>
							<Box flexDirection="row" flexShrink={0}>
								<MutedText>{"\u2303T mode"}</MutedText>
								{!processPanel.sidebarOpen && <ProcessBadge counts={processPanel.taskCounts} />}
							</Box>
						</>
					)}
				</Box>

				{showAnimations && <ShortcutDock viewportWidth={viewport.width} />}
			</FixedFrame>
		</ADHDModeContext.Provider>
	);
}

// Personality completion phrases
const COMPLETION_PHRASES = [
	"Splendid. Task complete.",
	"Another victory for elegant code.",
	"Infinity achieved, as always.",
	"The gentleman delivers.",
	"Perfection, if I do say so myself.",
	"Consider it done. Magnificently.",
	"Executed with characteristic grace.",
	"As expected, excellence prevails.",
];

// Generate a mock response with personality flavor (replace with actual agent logic)
function generateResponse(input: string): string {
	const completionPhrase =
		COMPLETION_PHRASES[Math.floor(Math.random() * COMPLETION_PHRASES.length)];

	const responses = [
		`[\u221E 8gent] Processing: "${input}"\n\n\u2713 Toolshed query complete\n\u2713 AST retrieval: 3 files analyzed\n\u2713 Context compression: 42% tokens saved\n\n${completionPhrase}`,

		`[\u221E 8gent] Analyzing request...\n\n\u25B8 Planner: Identified 2 subtasks\n\u25B8 Toolshed: Found 5 relevant symbols\n\u25B8 Execution: Preparing changes\n\nAST-first approach saved 1,247 tokens.\n\n${completionPhrase}`,

		`[\u221E 8gent] Query understood.\n\n\`\`\`typescript\n// Extracted context\nfunction processRequest(input: string) {\n  return analyze(input);\n}\n\`\`\`\n\nToken efficiency: 38% improvement over raw context.\n\n${completionPhrase}`,

		`[\u221E 8gent] Task complete.\n\n\u2022 Files analyzed: 7\n\u2022 Symbols extracted: 23\n\u2022 Context size: 2.1k tokens (vs 5.8k raw)\n\u2022 Savings: 64%\n\nStructured agentic development in action.\n\n${completionPhrase}`,
	];

	return responses[Math.floor(Math.random() * responses.length)];
}
