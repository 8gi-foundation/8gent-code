/**
 * 8gent Code - Agent Core
 *
 * The main agent orchestrator. Powered by the Vercel AI SDK via packages/ai.
 * Uses ToolLoopAgent for the agentic loop instead of a manual while loop.
 *
 * v2: Emits step_start/step_end/assistant_content session entries with
 * full AI SDK data (finishReason, reasoning, detailed token usage, etc.)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexFolder as astIndexFolder } from "../ast-index";
import { getExtensionManager } from "../extensions";
import { type HookManager, getHookManager } from "../hooks";
import { type InfiniteRunner, type InfiniteState, createInfiniteRunner } from "../infinite";
import { KernelManager } from "../kernel/manager";
import { getLSPManager } from "../lsp";
import { extractAutoMemories, getMemoryManager } from "../memory";
import { type OrchestratorBus, getOrchestratorBus } from "../orchestration/orchestrator-bus";
import { forceLocalModel, privacyGate } from "../permissions/privacy-router";
import { type FailoverEntry, ModelFailover } from "../providers/failover";
import { type ProactivePlanner, getProactivePlanner } from "../planning/proactive-planner";
import { extractBranchName, extractCommitHash } from "../reporting";
import { type RunLogEntry, appendRun } from "../reporting/runlog";
import { getVault } from "../secrets";
import { type HeartbeatAgents, getHeartbeatAgents } from "../self-autonomy/heartbeat";
import { OnboardingManager } from "../self-autonomy/onboarding";
import type {
	AgentInfo,
	ContentPart,
	DetailedTokenUsage,
	Environment,
} from "../specifications/session/index.js";
import { SessionWriter } from "../specifications/session/writer.js";
import { getActiveTelegramBot, startTelegramBot } from "../telegram";
import { type Evidence, EvidenceCollector, summarizeEvidence } from "../validation/evidence";
import { createClient } from "./clients";
import {
	type CompressionStage,
	DEFAULT_PROACTIVE_CONFIG,
	ProactiveCompression,
	type ProactiveResult,
} from "./compaction";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { ORCHESTRATOR_SEGMENT, buildOrchestratorContext } from "./prompts/orchestrator-prompt";
import { buildToolCatalogSegment } from "./prompts/system-prompt";
import { SessionSyncManager } from "./session-sync";
import { ToolLoopDetector } from "./tool-loop-detector";
import { ToolRegistry, getDeferredToolSegment } from "./tool-registry";
import { ToolExecutor } from "./tools";
import type { AgentConfig, AgentEventCallbacks } from "./types";
import { VisionInterpreter } from "./vision-interpreter";
import { type Settings, computeAutoTune } from "./auto-tune";

// Proactive questioning — asks clarifying questions before executing vague tasks
import {
	type ProactiveGatherer,
	createGatherer,
	formatQuestion,
	needsClarification,
} from "../proactive";

import { BRAND } from "../personality/brand.js";
// Personality voice — the infinite gentleman
import {
	PERSONALITY,
	flavorResponse,
	getCompletionPhrase,
	getErrorPhrase,
	getGreeting,
	voice as personalityVoice,
} from "../personality/voice.js";

// Workflow validation — BMAD plan-validate loop + Kanban tracking
// (PlanValidateLoop import removed in v0.11.1 — was never used at runtime.)
import {
	type BMadTask,
	PROACTIVE_SYSTEM_ADDITION,
	type Step,
	classifyTaskSize,
	decomposeTask,
	formatPlan,
	generateAcceptanceCriteria,
	getKanbanBoard,
	parsePlanFromResponse,
} from "../workflow";

// AI SDK imports
import {
	type EightAgentConfig,
	type ProviderConfig,
	type ProviderName,
	type StepFinishEvent,
	createEightAgent,
	createModel,
	getRuntimeParams,
	setRuntimeParams,
	setToolContext,
} from "../ai";

export class Agent {
	private executor: ToolExecutor;
	private config: AgentConfig;
	private hookManager: HookManager;
	private sessionId: string;
	private sessionStartTime: number;
	private enableReporting = true;
	private totalCost: number | null = null;
	private sessionWriter: SessionWriter;
	private messageHistory: Array<{ role: string; content: string }> = [];
	private toolCallTracker: Map<string, number> = new Map(); // fingerprint -> count
	private loopWarningInjected = false;
	private loopDetector = new ToolLoopDetector();
	private events: AgentEventCallbacks;
	private planner: ProactivePlanner;
	private evidenceCollector: EvidenceCollector;
	private sessionEvidence: Evidence[] = [];
	private proactiveGatherer: ProactiveGatherer | null = null;
	// workflowValidator: removed in v0.11.1. PlanValidateLoop was constructed in
	// the ctor but never invoked (only referenced in a comment). Eager init was
	// pulling tree-sitter + 3 sub-modules into cold start for nothing.
	private kanban = getKanbanBoard();
	private currentBmadTask: BMadTask | null = null;
	private heartbeat: HeartbeatAgents;
	private onboarding: OnboardingManager;
	private infiniteRunner: InfiniteRunner | null = null;
	private infiniteModeActive = false;
	private sessionSync: SessionSyncManager;
	private kernel: KernelManager;
	private abortController: AbortController | null = null;
	private orchestratorBus: OrchestratorBus;
	private toolRegistry: ToolRegistry;
	private compaction: ProactiveCompression;
	private recentFilePaths: string[] = [];

	constructor(config: AgentConfig) {
		this.config = config;
		this.events = config.events || {};
		this.executor = new ToolExecutor(config.workingDirectory || process.cwd());
		this.hookManager = getHookManager();
		this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.sessionStartTime = Date.now();

		// v0.12.0: lite mode is now the default. The agent boots fast and lean.
		// Opt back into the heavy auxiliaries (kernel training, heartbeat agents,
		// Convex sync, AST pre-indexing) by setting 8GENT_FULL=1 - or per-feature
		// via the granular env flags below.
		// Compat: 8GENT_LITE=0 explicitly forces the old "everything on" behaviour.
		//
		// v0.12.x: if `~/.8gent/settings.json` exists (sibling Settings View PR),
		// `computeAutoTune` resolves the user's "auto"/"lite"/"full" preference
		// against env + TTY state. Falls back to the original env-var rule when
		// the settings file is absent or malformed.
		const autoTuneSettings = readSettingsFileSync();
		const LITE =
			autoTuneSettings !== null
				? computeAutoTune(autoTuneSettings).liteMode
				: process.env["8GENT_LITE"] === "0" || process.env["8GENT_FULL"] === "1"
					? false
					: true;

		// Set working directory for hooks
		this.hookManager.setWorkingDirectory(config.workingDirectory || process.cwd());

		// Set tool context for AI SDK tools
		setToolContext({
			workingDirectory: config.workingDirectory || process.cwd(),
		});

		// Initialize deferred tool registry (allTools flag loads everything upfront)
		this.toolRegistry = new ToolRegistry(config.allTools ?? false);
		this.compaction = new ProactiveCompression();

		// Fire-and-forget AST indexing of working directory for AST-first retrieval.
		// Lite mode skips it — first AST tool call will index on demand.
		const cwd = config.workingDirectory || process.cwd();
		if (!LITE) {
			astIndexFolder(cwd)
				.then((index) => {
					// Gated behind DEBUG: stdout writes after Ink mounts get buffered
					// above the frame and push the rounded header out of the viewport.
					if (process.env.DEBUG === "1") {
						console.log(`[AST] Indexed ${index.fileCount} files, ${index.symbolCount} symbols`);
					}
				})
				.catch(() => {
					// AST indexing is best-effort, don't block agent startup
				});
		}

		// Initialize proactive planner and evidence collector
		this.planner = getProactivePlanner();
		this.evidenceCollector = new EvidenceCollector({
			workingDirectory: config.workingDirectory || process.cwd(),
		});

		// PlanValidateLoop construction removed in v0.11.1 — was never invoked,
		// only the field assignment was alive (~ -50ms cold start, fewer imports).

		// ── Self-Autonomy: Onboarding ────────────────────────────────────
		// Check if first run — if .8gent/user.json doesn't exist, flag for onboarding
		// NOTE: Initialized here (before system prompt) so user context can be injected
		this.onboarding = new OnboardingManager(config.workingDirectory || process.cwd());
		if (this.onboarding.needsOnboarding()) {
			// Detect integrations (Ollama, LM Studio, GitHub) in background
			this.onboarding.detectIntegrations().catch(() => {});
			// Gated behind DEBUG so stdout writes don't push the TUI header
			// out of the viewport on first launch.
			if (process.env.DEBUG === "1") {
				console.log(
					"[8gent] First run detected - onboarding available. The agent can ask setup questions.",
				);
			}
		}

		// Build system prompt with personality voice injected
		const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
		const languageInstruction = this.getLanguageInstruction();

		// Inject user context from onboarding data
		const userData = this.onboarding.getUser();
		let userContextBlock = "";
		if (userData.onboardingComplete || userData.identity.name) {
			const { USER_CONTEXT_SEGMENT } = require("./prompts/system-prompt");
			userContextBlock = USER_CONTEXT_SEGMENT({
				name: userData.identity.name,
				role: userData.identity.role,
				communicationStyle: userData.identity.communicationStyle,
				language: userData.identity.language,
			});
			if (userContextBlock) {
				userContextBlock = `\n\n${userContextBlock}`;
			}
		}

		// Inject the 8gent personality voice into the system prompt
		const personalityBlock = `\n\n## PERSONALITY VOICE — ${BRAND.fullName}: ${PERSONALITY.tagline}
You are ${PERSONALITY.name}, the infinite gentleman agent coder.
Traits: refined, witty, confident, helpful, endlessly capable.
When greeting users, use phrases like: "${getGreeting()}"
When completing tasks, use phrases like: "${getCompletionPhrase()}"
When encountering errors, stay composed: "${getErrorPhrase()}"
Maintain a tone that is sophisticated yet approachable — like a well-dressed engineer who happens to be brilliant.\n`;

		// Inject orchestrator awareness into system prompt
		const orchestratorBlock = `\n\n${ORCHESTRATOR_SEGMENT}`;

		// Inject vessel context if running as a deployed instance (set by daemon at startup)
		const vesselContext = process.env.EIGHT_VESSEL_CONTEXT
			? `\n\n${process.env.EIGHT_VESSEL_CONTEXT}`
			: "";

		// Inject deferred tool categories when not loading all tools upfront
		const deferredToolBlock = config.allTools ? "" : `\n\n${getDeferredToolSegment()}`;

		// Local providers have limited context windows — use a compact prompt that
		// still includes an honest tool catalog so the model never claims it has
		// no tools / no internet when it actually does. Closes #1082.
		const runtimeName = this.config.runtime as string;
		const isLocalRuntime =
			runtimeName === "lmstudio" || runtimeName === "ollama" || runtimeName === "8gent";
		const compactLocalPrompt = `You are 8gent, an autonomous coding agent. Use tools to read, write, edit, run commands, and search the web. Be concise. Never claim you cannot do something until you have tried the relevant tool.\n\n${buildToolCatalogSegment({ concise: true })}`;

		this.messageHistory.push({
			role: "system",
			content: isLocalRuntime
				? compactLocalPrompt
				: basePrompt +
					vesselContext +
					userContextBlock +
					personalityBlock +
					orchestratorBlock +
					deferredToolBlock +
					languageInstruction,
		});

		// Initialize session persistence (v2)
		this.sessionWriter = new SessionWriter(this.sessionId);
		const systemPromptFull =
			basePrompt + userContextBlock + personalityBlock + orchestratorBlock + languageInstruction;
		const agentInfo: AgentInfo = {
			model: config.model,
			runtime: config.runtime,
			maxTurns: config.maxTurns,
			maxSteps: config.maxTurns || 30,
			systemPromptHash: crypto
				.createHash("sha256")
				.update(systemPromptFull)
				.digest("hex")
				.slice(0, 16),
		};
		const env: Environment = {
			workingDirectory: config.workingDirectory || process.cwd(),
			platform: process.platform as Environment["platform"],
			nodeVersion: process.version,
		};
		this.sessionWriter.writeSessionStart({
			sessionId: this.sessionId,
			version: 2,
			startedAt: new Date(this.sessionStartTime).toISOString(),
			agent: agentInfo,
			environment: env,
		});

		// Initialize Convex session sync (fire-and-forget, reads syncToConvex from config).
		// Lite mode: construct a disabled sync manager, no Convex probe.
		const syncEnabled = LITE ? false : this._readSyncToConvex();
		this.sessionSync = new SessionSyncManager(syncEnabled);
		if (!LITE && syncEnabled) {
			this.sessionSync
				.startSession(config.model, config.runtime, config.workingDirectory)
				.catch(() => {});
		}

		// Initialize kernel manager for personal LoRA training.
		// Lite mode: construct it but don't start the training proxy.
		this.kernel = KernelManager.fromProjectConfig(config.workingDirectory || process.cwd());
		if (!LITE) {
			this.kernel.start().catch(() => {});
		}

		// Initialize orchestrator bus for multi-agent coordination.
		// (Singleton getter — cheap, no background loops kicked off here.)
		this.orchestratorBus = getOrchestratorBus();

		// Populate git info asynchronously
		import("node:child_process")
			.then(({ exec }) => {
				exec("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 2000 }, (err, stdout) => {
					if (!err && stdout) env.gitBranch = stdout.trim();
				});
			})
			.catch(() => {});

		// Execute onStart hooks
		this.hookManager.executeHooks("onStart", {
			sessionId: this.sessionId,
			workingDirectory: config.workingDirectory || process.cwd(),
		});

		// Fire YAML SessionStart hooks (best-effort)
		this.hookManager
			.fire("SessionStart", {
				sessionId: this.sessionId,
				workingDirectory: config.workingDirectory || process.cwd(),
			})
			.catch(() => {
				/* SessionStart hooks are best-effort */
			});

		// Remove any persisted shell-based voice hooks
		const allHooks = this.hookManager.getAllHooks();
		for (const hook of allHooks) {
			if (hook.name === "Voice Completion" && hook.mode === "shell") {
				this.hookManager.unregisterHook(hook.id!);
			}
		}

		// ── Self-Autonomy: Heartbeat ─────────────────────────────────────
		// Start background heartbeat agents (git monitoring, self-heal, memory sync).
		// Lite mode: construct the manager but don't start the loops. Saves
		// idle CPU/RAM and one of the slower cold-start steps.
		this.heartbeat = getHeartbeatAgents({
			workingDirectory: config.workingDirectory || process.cwd(),
			verbose: false,
		});
		if (!LITE) {
			this.heartbeat.start();
			this.heartbeat.updateContext({ currentTask: "Agent initialized" });
		}

		// ── Telegram: Auto-start if token exists in vault ────────────────
		const vault = getVault();
		if (vault.has("TELEGRAM_BOT_TOKEN") && !getActiveTelegramBot()) {
			const telegramToken = vault.get("TELEGRAM_BOT_TOKEN");
			if (telegramToken) {
				const chatId = vault.get("TELEGRAM_CHAT_ID");
				startTelegramBot(telegramToken, this, {
					allowedUsers: chatId ? [Number.parseInt(chatId, 10)] : undefined,
				}).catch((err) => {
					if (process.env.DEBUG === "1") {
						console.log(`[8gent] Telegram auto-start failed: ${err.message}`);
					}
				});
			}
		}

		// ── Extensions: Load from ~/.8gent/extensions/ ──────────────────
		const extMgr = getExtensionManager();
		extMgr
			.loadAll()
			.then((exts) => {
				const loaded = exts.filter((e) => e.status === "loaded");
				if (loaded.length > 0) {
					const extTools = extMgr.getTools();
					for (const [name, fn] of Object.entries(extTools)) {
						// Register as AI SDK tools via the tool registry
						this.toolRegistry.registerExternalTool(name, fn);
					}
					if (process.env.DEBUG === "1") {
						console.log(
							`[ext] ${loaded.length} extension(s), ${Object.keys(extTools).length} tool(s) registered`,
						);
					}
				}
			})
			.catch((err) => {
				if (process.env.DEBUG === "1") {
					console.log(`[ext] Extension loading failed: ${err}`);
				}
			});
	}

	async chat(userMessage: string, imageBase64?: string, imageMimeType?: string): Promise<string> {
		// Reset circuit breaker and privacy tracker for each new turn
		this.loopDetector.reset();
		this.recentFilePaths = [];

		const textForAgent =
			userMessage.trim() ||
			(imageBase64
				? "The user attached an image with no text. Describe what you see and help with anything relevant in the image."
				: userMessage);

		// If image attached, fire off parallel vision interpretation (like /btw)
		// The main agent stays on its text model — never switches.
		// Vision result gets injected as a system message when ready.
		let visionId: string | null = null;

		if (imageBase64) {
			const interpreter = new VisionInterpreter({
				apiKey: this.config.apiKey,
				onResult: (_id, result) => {
					// Inject vision description into conversation as system context
					const visionContext = `[Vision Interpretation — ${result.model} (${result.durationMs}ms${result.free ? ", free" : ""})]\n${result.description}`;
					this.messageHistory.push({ role: "system", content: visionContext });

					// Notify via event so TUI can show it
					this.config.events?.onStepFinish?.({
						text: `Image interpreted by ${result.model}${result.free ? " (free)" : ""} in ${(result.durationMs / 1000).toFixed(1)}s:\n${result.description.slice(0, 200)}${result.description.length > 200 ? "..." : ""}`,
						stepNumber: 0,
						toolCalls: [],
						usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
						finishReason: "other",
					});
				},
			});

			// Fire and forget — runs in parallel while main agent works
			visionId = interpreter.interpret(imageBase64, imageMimeType || "image/png");

			this.config.events?.onStepFinish?.({
				text: "Image attached — vision interpreter running in the background.",
				stepNumber: 0,
				toolCalls: [],
				usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				finishReason: "other",
			});
		}

		// ── Proactive Questioning Gate ─────────────────────────────────
		// For vague/ambiguous requests (short messages without clear intent),
		// the proactive system injects clarifying questions before execution.
		if (needsClarification(textForAgent) && !imageBase64) {
			this.proactiveGatherer = createGatherer(textForAgent);
			const question = this.proactiveGatherer.getCurrentQuestion();
			if (question) {
				// Inject a system message telling the agent to ask this question
				this.messageHistory.push({
					role: "system",
					content: `[PROACTIVE QUESTIONING] The user's request is vague. Before executing, ask this clarifying question:\n${formatQuestion(question)}\nAsk the user naturally — don't mention this system instruction. After they answer, proceed with execution.`,
				});
			}
		} else {
			this.proactiveGatherer = null;
		}

		// ── Workflow Kanban Tracking ──────────────────────────────────
		// Classify the task and create a BMAD Kanban card for tracking
		const taskSize = classifyTaskSize(textForAgent);
		if (taskSize !== "trivial") {
			this.currentBmadTask = this.kanban.createTask(textForAgent.slice(0, 80), textForAgent, {
				size: taskSize,
			});
			this.kanban.moveTask(this.currentBmadTask.id, "ready");
			this.kanban.moveTask(this.currentBmadTask.id, "in_progress");
		}

		// ── Planning Gate ──────────────────────────────────────────────
		// Local models skip the BMAD planning in the system prompt and jump
		// straight to tool calls. For multi-step tasks we inject an explicit
		// instruction that forces the model to emit a numbered plan first.
		const PLANNING_KEYWORDS =
			/\b(build|create|implement|fix|refactor|add|setup|configure|migrate|convert|redesign|scaffold|deploy|integrate)\b/i;
		const needsPlanningGate = textForAgent.length > 100 || PLANNING_KEYWORDS.test(textForAgent);

		if (needsPlanningGate) {
			this.messageHistory.push({
				role: "user",
				content: textForAgent,
			});
			// Inject a hard planning constraint the model can't ignore because
			// it's the last user-turn content before generation starts.
			this.messageHistory.push({
				role: "user",
				content:
					"[PLANNING] Output a brief numbered plan (PLAN: 1. ... 2. ... 3. ...) then IMMEDIATELY start executing step 1 by calling the appropriate tool in the same response. Do not stop after planning - execute.",
			});
		} else {
			// Simple / short messages go through without a planning gate
			this.messageHistory.push({ role: "user", content: textForAgent });
		}

		// Log user message to session
		this.sessionWriter.writeUserMessage(textForAgent);

		// Reset cost tracking for this run
		this.totalCost = null;

		const chatStartTime = Date.now();
		let totalTokensUsed = 0;
		let stepCount = 0;

		// Build provider config — main agent always uses its own model
		const providerConfig: ProviderConfig = {
			name: this.config.runtime as ProviderName,
			model: this.config.model,
			apiKey: this.config.apiKey,
		};

		// Build system instructions
		const systemPrompt = this.messageHistory.find((m) => m.role === "system")?.content;

		// Create the AI SDK agent with v2 session callbacks
		// Local providers have limited context — cap at core tools to avoid "Context size exceeded".
		// web_search/web_fetch included so local models can answer current-info questions.
		const CORE_TOOLS = [
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"run_command",
			"get_outline",
			"get_symbol",
			"search_symbols",
			"git_status",
			"git_diff",
			"git_add",
			"git_commit",
			"web_search",
			"web_fetch",
			"suggest_design",
			"query_design_system",
			"self_inspect",
			"self_tune",
			"self_append_context",
			"remember",
			"recall",
		];
		const providerName = providerConfig.name as string;
		const isLocalProvider =
			providerName === "lmstudio" || providerName === "ollama" || providerName === "8gent";
		// Deferred registry only loads `core` upfront — make sure local providers
		// get `web` (and git) before we filter, otherwise CORE_TOOLS entries like
		// web_search won't exist to pass through.
		if (isLocalProvider) {
			this.toolRegistry.loadCategory("web");
			this.toolRegistry.loadCategory("git");
			this.toolRegistry.loadCategory("design");
			this.toolRegistry.loadCategory("self");
			this.toolRegistry.loadCategory("memory");
		}
		const allTools = this.toolRegistry.getTools();
		const effectiveTools = isLocalProvider
			? Object.fromEntries(Object.entries(allTools).filter(([k]) => CORE_TOOLS.includes(k)))
			: allTools;

		// ── Populate runtime params for self-awareness tools ──────────
		const runtimeState = getRuntimeParams();
		setRuntimeParams({
			model: providerConfig.model,
			provider: providerConfig.name,
			toolCount: Object.keys(effectiveTools).length,
			loadedCategories: this.toolRegistry.getLoadedCategories(),
			systemPromptLength: systemPrompt?.length || 0,
			messageHistoryLength: this.messageHistory.length,
			stepCount: stepCount,
			maxSteps: this.config.maxTurns || 30,
			maxOutputTokens: isLocalProvider ? 4096 : 8192,
		});

		// Apply any previously tuned params
		const tunedParams = getRuntimeParams();

		// Inject appended context into instructions
		let effectiveInstructions = systemPrompt || "";
		if (tunedParams.appendedContext.length > 0) {
			effectiveInstructions += `\n\n## Agent Self-Appended Context\n${tunedParams.appendedContext.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`;
		}

		// Voice-chat awareness: when the TUI is in voice mode, tell the agent
		// the modality so it doesn't waste a turn explaining it can't hear.
		// The user speaks via STT; the agent's text reply is spoken via TTS.
		if (tunedParams.voiceChatActive) {
			effectiveInstructions += `

## Voice Chat Mode (active)
You are in a real-time voice conversation. The user is speaking to you; their words arrive as transcribed text (STT). Your written replies are spoken back to them via text-to-speech (TTS). You are NOT a text-only interface — you can hear them and they can hear you. Speak conversationally as if on a phone call. Do not apologise for being text-only or claim you cannot hear them — you can. Keep replies concise and natural since they will be spoken aloud. Avoid heavy markdown, code blocks, or long URLs — they don't read well in TTS.`;
		}

		let agentConfig: EightAgentConfig = {
			provider: providerConfig,
			instructions: effectiveInstructions,
			maxSteps: tunedParams.maxSteps,
			maxOutputTokens: tunedParams.maxOutputTokens,
			temperature: tunedParams.temperature,
			topP: tunedParams.topP,
			topK: tunedParams.topK,
			frequencyPenalty: tunedParams.frequencyPenalty,
			presencePenalty: tunedParams.presencePenalty,
			workingDirectory: this.config.workingDirectory || process.cwd(),
			tools: effectiveTools,

			onToolCallStart: async (event) => {
				await this.hookManager.executeHooks("beforeTool", {
					sessionId: this.sessionId,
					tool: event.toolName,
					toolInput: event.args,
					workingDirectory: this.config.workingDirectory || process.cwd(),
				});

				// Fire YAML PreToolUse hooks - if any hook blocks, skip the tool
				const preResult = await this.hookManager.fire("PreToolUse", {
					tool: event.toolName,
					args: event.args,
					sessionId: this.sessionId,
				});
				if (preResult.blocked) {
					console.log(`  [BLOCKED] ${event.toolName} - ${preResult.reason}`);
					throw new Error(`Hook blocked tool "${event.toolName}": ${preResult.reason}`);
				}

				// ── NemoClaw Privacy Gate: track file paths for sensitive context detection
				const toolPath = event.args?.path as string | undefined;
				if (
					toolPath &&
					["read_file", "write_file", "edit_file", "delete_file"].includes(event.toolName)
				) {
					this.recentFilePaths.push(toolPath);
					// Keep bounded - only last 20 paths
					if (this.recentFilePaths.length > 20) this.recentFilePaths.shift();

					const gate = privacyGate(this.recentFilePaths, providerConfig.name);
					if (gate.shouldForceLocal) {
						const fallback = forceLocalModel(providerConfig.name);
						if (fallback) {
							console.log(`\n\x1b[33m[PRIVACY] ${gate.reason}\x1b[0m`);
							console.log(
								`\x1b[33m[PRIVACY] Switching to ${fallback.provider}/${fallback.model}\x1b[0m`,
							);
							providerConfig.name = fallback.provider as typeof providerConfig.name;
							providerConfig.model = fallback.model;
							providerConfig.apiKey = undefined;
						}
					}
				}

				console.log(`  -> ${event.toolName}(${JSON.stringify(event.args).slice(0, 50)}...)`);

				this.events.onToolStart?.({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					args: event.args,
					stepNumber: event.stepNumber,
				});

				this.sessionWriter.writeToolCall(
					{
						toolCallId: event.toolCallId,
						name: event.toolName,
						arguments: event.args,
						success: true,
						durationMs: 0,
						startedAt: new Date().toISOString(),
					},
					undefined,
					event.stepNumber,
				);
			},

			onToolCallFinish: async (event) => {
				const resultStr =
					typeof event.result === "string" ? event.result : JSON.stringify(event.result);

				// Loop detection: track repeated tool calls with similar args
				const fingerprint = `${event.toolName}:${JSON.stringify(event.args).slice(0, 200)}`;
				const count = (this.toolCallTracker.get(fingerprint) || 0) + 1;
				this.toolCallTracker.set(fingerprint, count);

				if (count >= 3 && !event.success && !this.loopWarningInjected) {
					this.loopWarningInjected = true;
					console.log(
						`\n⚠️  [LOOP DETECTED] Tool "${event.toolName}" has been called ${count} times with similar args and keeps failing.`,
					);
					console.log("   Injecting guidance to try a different approach.\n");
					// Inject a system-level nudge into the conversation
					this.messageHistory.push({
						role: "user",
						content: `[SYSTEM WARNING — LOOP DETECTED] You have tried the same approach (${event.toolName} with similar arguments) ${count} times and it keeps failing. STOP retrying this approach. Instead:\n1. Use web_search to look up the correct API/pattern\n2. Try a COMPLETELY different strategy\n3. If you don't know how a library works, search for its documentation first\nDo NOT repeat the same fix again.`,
					});
				}

				// Reset loop warning flag on successful calls so it can fire again for new loops
				if (event.success) {
					this.loopWarningInjected = false;
				}

				// Circuit breaker: record call and check for loop patterns
				this.loopDetector.record(event.toolName, event.args as Record<string, unknown>);
				const loopResult = this.loopDetector.check();
				if (loopResult) {
					console.log(`\n[CIRCUIT BREAKER] ${loopResult.message}`);
					this.abort();
				}

				if (event.success) {
					this.sessionWriter.writeToolResult(
						event.toolCallId,
						true,
						resultStr.slice(0, 2000),
						event.durationMs,
						event.toolName,
						event.stepNumber,
					);
				} else {
					// v2: emit distinct tool_error entry
					const errorStr =
						typeof event.error === "string"
							? event.error
							: event.error instanceof Error
								? event.error.message
								: JSON.stringify(event.error);
					this.sessionWriter.writeToolError(
						event.toolCallId,
						event.toolName,
						errorStr,
						event.stepNumber,
					);
				}

				this.events.onToolEnd?.({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					args: event.args,
					success: event.success,
					durationMs: event.durationMs,
					stepNumber: event.stepNumber,
					resultPreview: resultStr.slice(0, 200),
				});

				// Record tool call for Convex session sync
				this.sessionSync.recordToolCall();

				// Track file operations
				if (event.success) {
					if (event.toolName === "write_file" && event.args.path) {
						this.sessionWriter.trackFileCreated(event.args.path as string);
					} else if (event.toolName === "edit_file" && event.args.path) {
						this.sessionWriter.trackFileModified(event.args.path as string);
					} else if (event.toolName === "delete_file" && event.args.path) {
						this.sessionWriter.trackFileDeleted(event.args.path as string);
					}
				}

				// Track git operations
				if (event.toolName === "git_commit" && resultStr.includes("[")) {
					const commitHash = extractCommitHash(resultStr);
					if (commitHash) {
						this.sessionWriter.trackGitCommit(commitHash);
					}
				}

				// Update proactive planner context
				this.planner.updatePredictionContext({
					recentCommands: [`${event.toolName}(${JSON.stringify(event.args).slice(0, 100)})`],
					...(event.toolName === "write_file" || event.toolName === "edit_file"
						? { modifiedFiles: [String(event.args.path)] }
						: {}),
					...(!event.success && typeof event.error === "string" ? { lastError: event.error } : {}),
				});

				// Fire-and-forget evidence collection for significant operations
				if (
					event.success &&
					["write_file", "edit_file", "run_command", "git_commit"].includes(event.toolName)
				) {
					this.collectToolEvidence(event)
						.then((ev) => {
							if (ev.length > 0) {
								this.sessionEvidence.push(...ev);
								// Emit each evidence item to TUI in real-time
								for (const e of ev) {
									this.events.onEvidence?.({
										type: e.type,
										description: e.description,
										verified: e.verified,
										path: e.path,
										command: e.command,
									});
								}
							}
						})
						.catch(() => {}); // evidence is supplementary, never block
				}

				// Auto-memory: extract project facts from tool results
				if (event.success && ["read_file", "run_command"].includes(event.toolName)) {
					try {
						const autoFacts = extractAutoMemories(event.toolName, event.args, resultStr);
						if (autoFacts.length > 0) {
							const memory = getMemoryManager(this.config.workingDirectory || process.cwd());
							for (const { fact, layer } of autoFacts) {
								memory.remember(fact, layer, {
									source: `auto:${event.toolName}`,
								});
							}
						}
					} catch {
						// Auto-memory is best-effort, never block the agent
					}
				}

				await this.hookManager.executeHooks("afterTool", {
					sessionId: this.sessionId,
					tool: event.toolName,
					toolInput: event.args,
					toolOutput: resultStr,
					duration: event.durationMs,
					workingDirectory: this.config.workingDirectory || process.cwd(),
				});

				// Fire YAML PostToolUse hooks (non-blocking, best-effort)
				this.hookManager
					.fire("PostToolUse", {
						tool: event.toolName,
						args: event.args,
						result: resultStr.slice(0, 2000),
						success: event.success,
						durationMs: event.durationMs,
						sessionId: this.sessionId,
					})
					.catch(() => {
						/* PostToolUse hooks are best-effort */
					});
			},

			onStepFinish: async (event: StepFinishEvent) => {
				stepCount++;
				// Update runtime params so self_inspect shows live step count
				setRuntimeParams({
					stepCount,
					messageHistoryLength: this.messageHistory.length,
				});

				// Feed the step's text to the Thinking-box visualiser so the
				// param vector breathes with the live thoughts. No-op if no
				// TUI is attached (CLI / harness / pipe-friendly modes).
				try {
					const { notifyVisualiserToken } = await import("./visualiser-bridge");
					notifyVisualiserToken(event.text);
				} catch {
					// Bridge import failure: ignore. Agent loop unaffected.
				}

				this.events.onStepFinish?.({
					stepNumber: event.stepNumber,
					finishReason: event.finishReason,
					text: event.text ?? "",
					toolCalls: (event.toolCalls ?? []).map((tc: any) => ({
						toolName: tc.toolName ?? "",
						toolCallId: tc.toolCallId ?? "",
					})),
					usage: {
						promptTokens: event.usage.promptTokens,
						completionTokens: event.usage.completionTokens,
						totalTokens: event.usage.totalTokens,
					},
				});

				// Check for premature completion claims
				if (event.text?.includes("🎯 COMPLETED") && event.finishReason === "stop") {
					// The agent is claiming completion — this is fine, but log it for tracking
					console.log(`\n[Step ${event.stepNumber}] Agent claims COMPLETED. Verify tests passed.`);
				}

				// ── Plan Parsing → Kanban Feed + Workflow Validation ─────────
				// When the agent emits text containing "PLAN:" followed by numbered
				// steps, parse them and push into the proactive planner's kanban
				// board so they're visible in the TUI and tracked for completion.
				// Also feed the parsed steps into the workflow PlanValidateLoop
				// so each step is validated before the next one proceeds.
				if (event.text && /PLAN:\s*\n?\s*\d+[.)]/i.test(event.text)) {
					const injectedSteps = this.planner.injectPlanFromText(event.text);
					if (injectedSteps.length > 0) {
						console.log(
							`\n[Step ${event.stepNumber}] Parsed ${injectedSteps.length} plan steps → kanban ready queue`,
						);
						// Emit plan steps as a system-level event so the TUI can render them
						this.events.onStepFinish?.({
							stepNumber: event.stepNumber,
							finishReason: "other" as any,
							text: `📋 Plan detected (${injectedSteps.length} steps):\n${injectedSteps.map((s, i) => `  ${i + 1}. ${s.description}`).join("\n")}`,
							toolCalls: [],
							usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
						});

						// Parse into workflow validation steps and update BMAD Kanban
						const validationSteps = parsePlanFromResponse(event.text);
						if (validationSteps.length > 0 && this.currentBmadTask) {
							// Update the BMAD task's steps with the parsed plan
							for (const vs of validationSteps) {
								const bmadStep = this.currentBmadTask.steps.find((s) => s.status === "pending");
								if (bmadStep) {
									bmadStep.action = vs.action;
									this.kanban.updateStep(this.currentBmadTask.id, bmadStep.id, "in_progress");
								}
							}
							console.log(
								`[Workflow] ${validationSteps.length} steps registered for validation | ${formatPlan(validationSteps)}`,
							);
						}
					}
				}

				// Map AI SDK usage to DetailedTokenUsage
				const detailedUsage: DetailedTokenUsage = {
					promptTokens: event.usage.promptTokens,
					completionTokens: event.usage.completionTokens,
					totalTokens: event.usage.totalTokens,
					inputTokenDetails: event.usage.inputTokenDetails,
					outputTokenDetails: event.usage.outputTokenDetails,
					raw: event.usage.raw,
				};

				totalTokensUsed += event.usage.totalTokens;

				// Record tokens for Convex session sync (fire-and-forget)
				this.sessionSync.recordTokens(event.usage.promptTokens, event.usage.completionTokens);

				// Track cost from provider (OpenRouter sends it in raw)
				const rawCost = event.usage.raw?.cost;
				if (typeof rawCost === "number") {
					this.totalCost = (this.totalCost ?? 0) + rawCost;
				}

				const hasToolCalls = event.toolCalls && event.toolCalls.length > 0;

				if (hasToolCalls) {
					console.log(`\n[Step ${event.stepNumber}: executed ${event.toolCalls.length} tool(s)]`);
				}

				// v2: Write step_end with full AI SDK data
				this.sessionWriter.writeStepEnd(event.stepNumber, event.finishReason as any, {
					usage: detailedUsage,
					response: event.response,
					providerMetadata: event.providerMetadata,
				});

				// v2: Write rich assistant content if there's text or reasoning
				if (event.text || event.reasoning?.length || event.sources?.length || event.files?.length) {
					const parts: ContentPart[] = [];

					// Reasoning blocks first
					if (event.reasoning?.length) {
						for (const r of event.reasoning) {
							parts.push({
								type: "reasoning",
								text: r.text,
								signature: r.signature,
							});
						}
					}

					// Text content
					if (event.text) {
						parts.push({ type: "text", text: event.text });
					}

					// Sources
					if (event.sources?.length) {
						for (const s of event.sources) {
							parts.push({
								type: "source",
								sourceType: s.type,
								id: s.id,
								url: s.url,
								title: s.title,
							});
						}
					}

					// Generated files
					if (event.files?.length) {
						for (const f of event.files) {
							parts.push({
								type: "file",
								mediaType: f.mediaType,
								data: f.data,
							});
						}
					}

					this.sessionWriter.writeAssistantContent(event.stepNumber, parts, detailedUsage);
				}
			},

			onFinish: async () => {
				if (this.sessionEvidence.length > 0) {
					const summary = summarizeEvidence(this.sessionEvidence);
					console.log(`\n[Evidence: ${summary.verified}/${summary.total} verified]`);
					// Emit summary to TUI
					this.events.onEvidenceSummary?.(summary);
				}
			},
		};

		try {
			// Build messages array once - reused across every provider attempt.
			const messages = this.messageHistory
				.filter((m) => m.role !== "system")
				.map((m) => ({
					role: m.role as "user" | "assistant",
					content: m.content,
				}));

			// Create abort controller for ESC interruption (shared across attempts)
			this.abortController = new AbortController();

			// Deterministic self-healing: walk the failover chain on ANY error
			// (Bad Request, 5xx, network, schema, timeout). Within the same
			// provider, keep exponential backoff for 429 rate limits.
			const failover = new ModelFailover();
			const channel = "text" as const;
			const tried = new Set<string>();
			const errors: Array<{ provider: string; model: string; error: string }> = [];

			let currentEntry: FailoverEntry = {
				model: agentConfig.provider.model,
				provider: agentConfig.provider.name,
			};

			let result: any = null;
			let resolved = false;
			const MAX_PROVIDERS = 6; // hard cap so a misconfigured chain can't loop forever
			const RATE_LIMIT_ATTEMPTS = 4;

			outer: for (let chainStep = 0; chainStep < MAX_PROVIDERS; chainStep++) {
				const key = `${currentEntry.provider}::${currentEntry.model}`;
				if (tried.has(key)) break;
				tried.add(key);

				// Build agent for the current provider in the chain
				const stepConfig = {
					...agentConfig,
					provider: { name: currentEntry.provider as any, model: currentEntry.model },
				};
				const agent = createEightAgent(stepConfig);

				for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt++) {
					try {
						result = await agent.generate({
							messages,
							abortSignal: this.abortController?.signal,
						});
						resolved = true;
						// Update agentConfig so any downstream logic sees the provider that actually succeeded
						agentConfig = stepConfig;
						break outer;
					} catch (err: any) {
						if (err?.name === "AbortError") throw err; // User pressed ESC

						const msg = String(err?.message ?? err);
						const isRateLimit =
							msg.includes("429") ||
							/\brate[ -]?limit/i.test(msg) ||
							msg.includes("Provider returned error");

						if (isRateLimit && attempt < RATE_LIMIT_ATTEMPTS) {
							const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
							console.log(
								`[agent] ${currentEntry.provider}/${currentEntry.model} rate limited, retry in ${delay / 1000}s (${attempt}/${RATE_LIMIT_ATTEMPTS})`,
							);
							await new Promise((r) => setTimeout(r, delay));
							continue;
						}

						// Any other error -> mark provider down, advance chain, restart
						console.log(
							`[agent] ${currentEntry.provider}/${currentEntry.model} failed: ${msg.slice(0, 200)} -> failover`,
						);
						errors.push({
							provider: currentEntry.provider,
							model: currentEntry.model,
							error: msg.slice(0, 200),
						});
						failover.markDown(currentEntry.model, currentEntry.provider);
						const next = failover.resolve(currentEntry.model, channel);
						if (
							next.model === currentEntry.model &&
							next.provider === currentEntry.provider
						) {
							break outer; // chain exhausted
						}
						currentEntry = next;
						break; // exit inner attempt loop, outer reuses new currentEntry
					}
				}
			}

			this.abortController = null;

			if (!resolved) {
				const summary = errors
					.map((e) => `  - ${e.provider}/${e.model}: ${e.error}`)
					.join("\n");
				throw new Error(
					`All providers exhausted (${errors.length} attempted):\n${summary || "  (no provider errors recorded)"}`,
				);
			}

			// ── Adaptive recovery: if the model planned but never called tools,
			// it likely hit the output token limit mid-response. Retry once with
			// a larger maxOutputTokens so it can fit plan + first tool call.
			if (
				isLocalProvider &&
				stepCount <= 1 &&
				result.text &&
				result.text.length > 50 &&
				!agentConfig.maxOutputTokens // only retry once
			) {
				const hadToolCalls = result.steps?.some((s: any) => s.toolCalls?.length > 0);
				if (!hadToolCalls) {
					console.log(
						`[agent] No tool calls after ${stepCount} step(s) - bumping maxOutputTokens to 8192 and retrying`,
					);
					agentConfig.maxOutputTokens = 8192;
					const retryAgent = createEightAgent(agentConfig);
					this.abortController = new AbortController();
					const messages2 = this.messageHistory
						.filter((m) => m.role !== "system")
						.map((m) => ({
							role: m.role as "user" | "assistant",
							content: m.content,
						}));
					try {
						result = await retryAgent.generate({
							messages: messages2,
							abortSignal: this.abortController?.signal,
						});
					} catch (retryErr: any) {
						if (retryErr?.name === "AbortError") throw retryErr;
						console.log(`[agent] Retry with larger maxOutputTokens failed: ${retryErr?.message}`);
					}
					this.abortController = null;
				}
			}

			const content = result.text;

			// Apply personality voice flavoring to the response
			const flavor = personalityVoice.getFlavor("complete");
			const flavoredContent = flavorResponse(content, flavor);

			this.messageHistory.push({ role: "assistant", content: flavoredContent });

			// Feed successful turn to kernel for personal LoRA training (fire-and-forget)
			if (this.kernel.isActive || this.kernel.isEnabled) {
				this.kernel.collectSessionTrace(
					this.sessionId,
					textForAgent,
					flavoredContent,
					0.8, // Default score — PRM judge would score this properly if kernel is active
					{
						model: this.config.model,
						toolCallsSucceeded: this.sessionEvidence.filter((e) => !e.verified).length === 0,
						userCorrected: false, // Will be updated on next user message if it's a correction
					},
				);
			}

			// Save checkpoint every 5 messages
			if (this.messageHistory.filter((m) => m.role === "user").length % 5 === 0) {
				this.sessionSync.saveCheckpoint(this.messageHistory).catch(() => {});
			}

			// Proactive context compression — Harbor Terminus-2 pattern (#1405)
			// Monitors token pressure and escalates through 4 stages:
			//   unwind -> summarize (3-step) -> simplify -> nuke-to-system
			if (this.compaction.shouldCompact(this.messageHistory)) {
				try {
					const stage = this.compaction.getStage(this.messageHistory);
					const compactModel = createModel(providerConfig);
					const { messages: compacted, result: compactionResult } =
						await this.compaction.compactProactive(this.messageHistory, compactModel);
					this.messageHistory = compacted;
					console.log(
						`  [COMPRESSION:${stage}] ${compactionResult.messagesRemoved} messages compressed, ` +
							`${compactionResult.tokensBefore} -> ${compactionResult.tokensAfter} tokens`,
					);
					this.events.onCompaction?.(compactionResult);
				} catch (err) {
					console.error("  [COMPRESSION] Failed:", (err as Error).message);
				}
			}

			// Move BMAD task to review/done if we had one
			if (this.currentBmadTask) {
				this.kanban.moveTask(this.currentBmadTask.id, "review");
				// If evidence looks good, move to done
				if (this.sessionEvidence.length > 0) {
					const verifiedCount = this.sessionEvidence.filter((e) => e.verified).length;
					if (verifiedCount > 0) {
						this.kanban.moveTask(this.currentBmadTask.id, "done");
					}
				}
			}

			// Append to run log
			const durationSec = Math.round((Date.now() - chatStartTime) / 1000);
			if (this.enableReporting) {
				appendRun({
					ts: new Date().toISOString(),
					status: "ok",
					model: this.config.model,
					dur: durationSec,
					tokens: totalTokensUsed,
					cost: this.totalCost,
					tools: stepCount,
					created: Array.from(this.sessionWriter.getFilesCreated()),
					modified: Array.from(this.sessionWriter.getFilesModified()),
					session: this.sessionId,
					cwd: this.config.workingDirectory || process.cwd(),
					prompt: textForAgent.slice(0, 120),
				});
			}
			const finalContent = flavoredContent;

			await this.hookManager.executeHooks("onComplete", {
				sessionId: this.sessionId,
				result: finalContent,
				duration: Date.now() - chatStartTime,
				tokenCount: totalTokensUsed || content.length,
				workingDirectory: this.config.workingDirectory || process.cwd(),
			});

			// Voice TTS
			try {
				const { voiceCompletionHook } = await import("../hooks/voice.js");
				await voiceCompletionHook({ result: finalContent });
			} catch {
				// Voice is optional
			}

			return flavoredContent;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);

			// ── Self-Autonomy: Error Recovery ────────────────────────────────
			// Report error to heartbeat for pattern tracking
			this.heartbeat.reportError(errMsg);

			// If infinite mode is active, attempt self-healing recovery
			if (this.infiniteModeActive && err instanceof Error) {
				const autonomy = this.heartbeat.getAutonomy();
				const severity = autonomy.heal.classifyError(errMsg);

				if (severity !== "fatal") {
					console.log(
						`[8gent:heal] Attempting recovery for ${severity} error: ${errMsg.slice(0, 80)}`,
					);
					try {
						const recovery = await autonomy.handleError(
							err,
							"agent-chat",
							() => this.chat(textForAgent, imageBase64, imageMimeType),
							2, // max 2 retries in infinite mode
						);
						if (recovery.success) {
							autonomy.heal.recordSuccess(errMsg.slice(0, 50), "retry");
							return recovery.result;
						}
					} catch {
						// Recovery itself failed, fall through to normal error handling
					}
				}
			}

			this.sessionWriter.writeError({
				message: errMsg,
				code: null,
				stack: err instanceof Error ? (err.stack ?? null) : null,
				recoverable: false,
			});

			// Fire YAML OnError hooks (best-effort)
			this.hookManager
				.fire("OnError", {
					error: errMsg,
					stack: err instanceof Error ? err.stack : undefined,
					sessionId: this.sessionId,
				})
				.catch(() => {
					/* OnError hooks are best-effort */
				});

			if (this.enableReporting) {
				appendRun({
					ts: new Date().toISOString(),
					status: "fail",
					model: this.config.model,
					dur: Math.round((Date.now() - chatStartTime) / 1000),
					tokens: totalTokensUsed,
					cost: this.totalCost,
					tools: stepCount,
					created: Array.from(this.sessionWriter.getFilesCreated()),
					modified: Array.from(this.sessionWriter.getFilesModified()),
					session: this.sessionId,
					cwd: this.config.workingDirectory || process.cwd(),
					prompt: textForAgent.slice(0, 120),
					error: errMsg.slice(0, 200),
				});
			}

			await this.hookManager.executeHooks("onComplete", {
				sessionId: this.sessionId,
				result: `Error: ${errMsg}`,
				duration: Date.now() - chatStartTime,
				workingDirectory: this.config.workingDirectory || process.cwd(),
			});

			throw err;
		}
	}

	/**
	 * Abort the current generation. Called when user presses ESC during processing.
	 */
	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
			console.log("[8gent] Generation aborted by user");
		}
	}

	private async collectToolEvidence(event: {
		toolName: string;
		args: Record<string, unknown>;
		result?: unknown;
	}): Promise<Evidence[]> {
		if ((event.toolName === "write_file" || event.toolName === "edit_file") && event.args.path) {
			return this.evidenceCollector.collectForFileWrite(String(event.args.path));
		}
		if (event.toolName === "git_commit") {
			return this.evidenceCollector.collectForGitCommit();
		}
		if (event.toolName === "run_command" && event.args.command) {
			return this.evidenceCollector.collectForCommand(
				String(event.args.command),
				typeof event.result === "string" ? event.result : JSON.stringify(event.result),
			);
		}
		return [];
	}

	async isReady(): Promise<boolean> {
		const client = createClient(this.config);
		return client.isAvailable();
	}

	clearHistory(): void {
		const systemMsg = this.messageHistory[0];
		this.messageHistory = systemMsg ? [systemMsg] : [];
	}

	getModel(): string {
		return this.config.model;
	}

	setModel(model: string): void {
		this.config.model = model;
	}

	getHistoryLength(): number {
		return this.messageHistory.length;
	}

	getWorkingDirectory(): string {
		return this.executor.getWorkingDirectory();
	}

	setReportingEnabled(enabled: boolean): void {
		this.enableReporting = enabled;
	}

	isReportingEnabled(): boolean {
		return this.enableReporting;
	}

	getSessionFilePath(): string {
		return this.sessionWriter.getFilePath();
	}

	getSessionEvidence(): Evidence[] {
		return this.sessionEvidence;
	}

	private getLanguageInstruction(): string {
		try {
			const { getLanguageManager } = require("../i18n/index.js");
			return getLanguageManager().getLanguageInstruction();
		} catch {
			return "";
		}
	}

	// ── Infinite Mode ─────────────────────────────────────────────────

	/**
	 * Enable infinite/autonomous execution mode.
	 * The agent will loop until the task is complete, recovering from errors automatically.
	 */
	enableInfiniteMode(
		task: string,
		config?: { maxIterations?: number; maxTimeMs?: number },
	): InfiniteRunner {
		this.infiniteModeActive = true;
		this.infiniteRunner = createInfiniteRunner(task, {
			maxIterations: config?.maxIterations ?? 100,
			maxTimeMs: config?.maxTimeMs ?? 30 * 60 * 1000,
			model: this.config.model,
			workingDirectory: this.config.workingDirectory || process.cwd(),
		});
		this.heartbeat.updateContext({ currentTask: `[INFINITE] ${task}` });
		console.log(`[8gent] Infinite mode enabled for task: ${task}`);
		return this.infiniteRunner;
	}

	/**
	 * Disable infinite mode
	 */
	disableInfiniteMode(): void {
		this.infiniteModeActive = false;
		if (this.infiniteRunner) {
			this.infiniteRunner.abort();
			this.infiniteRunner = null;
		}
		this.heartbeat.updateContext({ currentTask: "Infinite mode disabled" });
		console.log("[8gent] Infinite mode disabled");
	}

	isInfiniteModeActive(): boolean {
		return this.infiniteModeActive;
	}

	getOnboardingManager(): OnboardingManager {
		return this.onboarding;
	}

	getHeartbeat(): HeartbeatAgents {
		return this.heartbeat;
	}

	// ── Config Helpers ──────────────────────────────────────────────

	/**
	 * Read the syncToConvex flag from .8gent/config.json.
	 * Returns true by default if the db section exists, false if config is missing.
	 */
	private _readSyncToConvex(): boolean {
		try {
			const fs = require("node:fs");
			const path = require("node:path");
			const cwd = this.config.workingDirectory || process.cwd();
			const configPath = path.join(cwd, ".8gent", "config.json");
			const raw = fs.readFileSync(configPath, "utf-8");
			const config = JSON.parse(raw);
			// Check explicit syncToConvex flag first, then fall back to db.offlineMode
			if (typeof config.syncToConvex === "boolean") return config.syncToConvex;
			if (config.db?.offlineMode === false) return true;
			return false;
		} catch {
			return false; // No config = no sync
		}
	}

	/**
	 * Restore conversation from a checkpoint.
	 * Injects historical messages into the agent context.
	 */
	restoreFromCheckpoint(messages: Array<{ role: string; content: string }>): void {
		// Keep the system prompt, replace conversation history
		const systemMsg = this.messageHistory[0];
		this.messageHistory = systemMsg ? [systemMsg] : [];

		for (const msg of messages) {
			if (msg.role !== "system") {
				this.messageHistory.push(msg);
			}
		}

		console.log(`[8gent] Restored ${messages.length} messages from checkpoint`);
	}

	/**
	 * Get the session sync manager (for checkpoint/resume operations).
	 */
	getSessionSync(): SessionSyncManager {
		return this.sessionSync;
	}

	/**
	 * Get current message history (for checkpointing).
	 */
	getMessageHistory(): Array<{ role: string; content: string }> {
		return [...this.messageHistory];
	}

	/**
	 * Get the orchestrator bus for multi-agent coordination.
	 */
	getOrchestratorBus(): OrchestratorBus {
		return this.orchestratorBus;
	}

	async cleanup(): Promise<void> {
		// Flush and end Convex session sync
		await this.sessionSync.endSession().catch(() => {});
		// Stop kernel pipeline
		await this.kernel.stop().catch(() => {});
		// Shutdown orchestrator bus and all sub-agents
		await this.orchestratorBus.shutdown().catch(() => {});
		// Stop heartbeat agents
		this.heartbeat.stop();

		// Stop Telegram bot if running
		const telegramBot = getActiveTelegramBot();
		if (telegramBot) {
			telegramBot.stop();
		}

		// Abort infinite mode if active
		if (this.infiniteRunner) {
			this.infiniteRunner.abort();
			this.infiniteRunner = null;
		}

		try {
			this.sessionWriter.writeSessionEnd("user_exit", null);
		} catch {
			// Session writer may already be closed
		}

		const manager = getLSPManager();
		await manager.stopAll();
	}
}

/**
 * Synchronously load `~/.8gent/settings.json` for use in the Agent constructor.
 *
 * The sibling Settings View PR owns the canonical `loadSettings()` reader.
 * Until that lands, we read the file directly here so the agent stays
 * decoupled from `packages/settings`. Returns `null` on any failure - the
 * caller falls back to the env-var-based detection.
 */
function readSettingsFileSync(): Settings | null {
	try {
		const file = path.join(os.homedir(), ".8gent", "settings.json");
		if (!fs.existsSync(file)) return null;
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as Settings;
		// Minimal shape check - avoid throwing on partially-written files.
		if (
			parsed &&
			typeof parsed === "object" &&
			parsed.performance &&
			typeof parsed.performance.mode === "string" &&
			typeof parsed.performance.introBanner === "string" &&
			parsed.voice &&
			typeof parsed.voice.silenceThresholdMs === "number"
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}
