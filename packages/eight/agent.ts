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
import type { HedgeCandidate } from "../kernel/hedge-executor";
import { KernelManager } from "../kernel/manager";
import { getLSPManager } from "../lsp";
import { extractAutoMemories, getMemoryManager } from "../memory";
import {
	generateSessionSummary,
	recallGlobalMemoriesSync,
	recallPriorSessionsSync,
	writeSessionToKG,
} from "../memory/session-kg.js";
import { type OrchestratorBus, getOrchestratorBus } from "../orchestration/orchestrator-bus";
import { forceLocalModel, privacyGate } from "../permissions/privacy-router";
import { type ProactivePlanner, getProactivePlanner } from "../planning/proactive-planner";
import { type FailoverEntry, ModelFailover } from "../providers/failover";
import { callLocalModelWithReroute } from "../providers/model-reroute";
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
import { type Settings, computeAutoTune } from "./auto-tune";
import { createClient } from "./clients";
import {
	type CompressionStage,
	DEFAULT_PROACTIVE_CONFIG,
	ProactiveCompression,
	type ProactiveResult,
} from "./compaction";
import {
	type AgentState as TwoStageAgentState,
	type CheckpointEntry,
	type Summarizer,
	TwoStageCompactor,
} from "./two-stage-compactor";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { ORCHESTRATOR_SEGMENT, buildOrchestratorContext } from "./prompts/orchestrator-prompt";
import { buildToolCatalogSegment } from "./prompts/system-prompt";
import { SessionSyncManager } from "./session-sync";
import {
	type CheckpointMeta,
	type RestoredCheckpoint,
	TimeTravelStore,
	checkpointEveryFromEnv,
} from "./timetravel/checkpoint-store";
import { ToolLoopDetector } from "./tool-loop-detector";
import { TurnJournal } from "./turn-journal";
import { resolveTurnTimeoutMs, withTurnTimeout } from "./turn-timeout";
import { ToolRegistry, getDeferredToolSegment } from "./tool-registry";
import { ToolExecutor } from "./tools";
import {
	PreToolRouter,
	formatPreFetchedContext,
	type RouterDecision,
} from "./pre-tool-router";
import type { AgentConfig, AgentEventCallbacks } from "./types";
import { VisionInterpreter } from "./vision-interpreter";

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
import {
	buildTextToolCall,
	needsTextTools,
	resolveTextToolEndpoint,
	runTextToolAgent,
	type TextTool,
	toolDefsToSpecs,
} from "../ai";

/**
 * Decide whether Agent.chat() should drive tools through the harness-side text
 * protocol instead of the AI SDK native tool loop. Mirrors bin/8gent.ts
 * chatCommand: lmstudio/ollama are the tool-incapable local providers whose
 * served chat templates 400 on a native `tools` payload. EIGHT_TEXT_TOOLS is an
 * explicit override: "1"/"true" forces text tools on for any provider, "0"/
 * "false" forces it off. Built on the pure needsTextTools gate so the single
 * source of truth for the native-vs-text decision stays in packages/ai.
 */
function shouldUseTextTools(providerName: string): boolean {
	const override = (process.env.EIGHT_TEXT_TOOLS || "").trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	const supportsNativeTools = providerName !== "lmstudio" && providerName !== "ollama";
	return needsTextTools({ supportsNativeTools });
}

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
	private twoStageCompactor: TwoStageCompactor | null = null;
	private twoStageCheckpoints: CheckpointEntry[] = [];
	// Time-travel (#2757): content-addressed checkpoints every N tool calls.
	// Lazily constructed so sessions that never call a tool pay nothing.
	private timeTravelStore: TimeTravelStore | null = null;
	private timeTravelToolCallsSinceCheckpoint = 0;
	private timeTravelTotalToolCalls = 0;
	private recentFilePaths: string[] = [];
	// TurnJournal (#2470): per-turn replayable record for debug + audit.
	private turnJournal: TurnJournal;
	private turnIndex = 0;
	private systemPromptHashFull = "";
	private systemPromptLengthFull = 0;
	private preToolRouter: PreToolRouter = new PreToolRouter({
		astAvailable: true,
		vectorAvailable: true,
	});

	constructor(config: AgentConfig) {
		this.config = config;
		this.events = config.events || {};
		this.executor = new ToolExecutor(config.workingDirectory || process.cwd(), "primary", undefined, {
			unattended: config.unattended ?? false,
		});
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

		// Two-stage compactor (issue #2467). Layered alongside ProactiveCompression
		// rather than replacing it: the legacy single-threshold engine still
		// guards hard limits; the two-stage path produces cheap mid-pressure
		// checkpoints so context loss is gradual instead of cliff-edged.
		// Summariser is a thin wrapper around the active provider's chat client;
		// constructed lazily on first observe so providerConfig is in scope.
		this.twoStageCompactor = null;

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

		// Inject prior session context and global user memories (best-effort, sync)
		const priorSessionsBlock = recallPriorSessionsSync(config.workingDirectory || process.cwd());
		const globalMemoriesBlock = recallGlobalMemoriesSync();

		// Local providers have limited context windows — use a compact prompt that
		// still includes an honest tool catalog so the model never claims it has
		// no tools / no internet when it actually does. Closes #1082.
		const runtimeName = this.config.runtime as string;
		const isLocalRuntime =
			runtimeName === "lmstudio" || runtimeName === "ollama" || runtimeName === "8gent";
		const compactLocalPrompt = `You are 8gent, an autonomous coding agent. Use tools to read, write, edit, run commands, and search the web. Be concise. Never claim you cannot do something until you have tried the relevant tool.\n\nCRITICAL: When the user shares ANY personal fact (name, preferences, habits, goals), IMMEDIATELY call the \`remember\` tool with layer \`global\`. Do not wait to be asked.${globalMemoriesBlock}${priorSessionsBlock}\n\n${buildToolCatalogSegment({ concise: true })}`;

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
					globalMemoriesBlock +
					priorSessionsBlock +
					languageInstruction,
		});

		// Initialize session persistence (v2)
		this.sessionWriter = new SessionWriter(this.sessionId);
		const systemPromptFull =
			basePrompt + userContextBlock + personalityBlock + orchestratorBlock + languageInstruction;
		// TurnJournal (#2470): hash the system prompt once at boot, stamp every
		// TurnRecord with it. Avoids re-hashing per turn for large prompts.
		this.turnJournal = new TurnJournal(this.sessionId);
		const sysPromptDigest = TurnJournal.hashSystemPrompt(systemPromptFull);
		this.systemPromptHashFull = sysPromptDigest.hash;
		this.systemPromptLengthFull = sysPromptDigest.length;
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
		// Connector 1 (ISI wiring): the personal collector early-returns false
		// forever unless a userId is set. Wire it ONCE here, but ONLY when the
		// kernel is enabled via training_proxy.enabled (default false). When the
		// flag is off this is a no-op, so collection stays dormant. The id is a
		// stable, local-only hash of host+home - never a network identity.
		if (!LITE && this.kernel.isEnabled) {
			try {
				const localUserId = crypto
					.createHash("sha256")
					.update(`${os.hostname()}::${os.homedir()}`)
					.digest("hex")
					.slice(0, 16);
				this.kernel.setUserId(localUserId);
			} catch {
				// If we cannot derive a stable id, leave collection dormant.
			}
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

	/**
	 * Text-tool agentic turn for tool-incapable local providers.
	 *
	 * Runs the harness-side `tool_call` protocol instead of the AI SDK native
	 * tool loop. Builds {spec, run} tools from the REAL ToolExecutor (so writes,
	 * edits, and run_command actually execute, honouring the working directory),
	 * drives the local model through buildTextToolCall (no native `tools`
	 * payload), and emits the same onToolStart/onToolEnd events the native path
	 * emits so the TUI step rail and the Pill work-surface render the calls live.
	 * Returns the final assistant text in the exact shape Agent.chat() normally
	 * returns (flavored prose), so app.tsx and agent-pool.ts render it unchanged.
	 */
	private async runTextToolChat(opts: {
		providerName: string;
		providerModel: string;
		instructions: string;
		localCoreTools: string[];
		chatStartTime: number;
		textForAgent: string;
	}): Promise<string> {
		const {
			providerName,
			providerModel,
			instructions,
			localCoreTools,
			chatStartTime,
			textForAgent,
		} = opts;

		// Live abort controller for THIS text-tool turn. The text-tool branch
		// returns before the native path creates its controller, so without this
		// `this.abortController` is null and this.abort() - fired by the circuit
		// breaker below, the session watchdog, and user ESC - would be a no-op.
		// Assigning it here makes all three actually stop the turn.
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		// Build the real tool set: intersect the executor's own tool definitions
		// (everything it can actually run) with the local CORE_TOOLS subset via a
		// spec-only conversion, then wire each spec's run() to the REAL executor
		// here so we can fire the tool lifecycle events both surfaces consume,
		// plus minimal session + loop-detector bookkeeping, around each call.
		const allow = new Set(localCoreTools);
		const specs = toolDefsToSpecs(
			this.executor.getToolDefinitions() as Array<{
				type?: string;
				function?: { name?: unknown; description?: unknown; parameters?: unknown };
			}>,
			allow,
		);

		let stepNumber = 0;
		const tools: TextTool[] = specs.map((spec) => ({
			spec,
			run: async (args: Record<string, unknown>) => {
				const toolName = spec.name;
				const toolCallId = `tt-${Date.now()}-${stepNumber}`;
				const step = stepNumber++;
				const startedAt = Date.now();

				// Track file paths for the privacy gate, matching the native path.
				const toolPath = (args as { path?: unknown }).path;
				if (
					typeof toolPath === "string" &&
					["read_file", "write_file", "edit_file", "delete_file"].includes(toolName)
				) {
					this.recentFilePaths.push(toolPath);
					if (this.recentFilePaths.length > 20) this.recentFilePaths.shift();
				}

				console.log(`  -> ${toolName}(${JSON.stringify(args).slice(0, 50)}...)`);
				this.events.onToolStart?.({ toolName, toolCallId, args, stepNumber: step });
				this.sessionWriter.writeToolCall(
					{
						toolCallId,
						name: toolName,
						arguments: args,
						success: true,
						durationMs: 0,
						startedAt: new Date(startedAt).toISOString(),
					},
					undefined,
					step,
				);

				let result = "";
				let success = true;
				try {
					result = await this.executor.execute(toolName, args);
					// The executor returns an error STRING rather than throwing for most
					// failure modes; treat a leading error marker as an unsuccessful call
					// for event + session bookkeeping.
					success = !/^(\[[A-Z_ ]*(BLOCKED|DENIED|ERROR)\]|Error:|Unknown tool:)/.test(
						result.trimStart(),
					);
				} catch (err) {
					success = false;
					result = `Error running tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`;
				}

				const durationMs = Date.now() - startedAt;

				// Circuit breaker / loop detection, mirroring the native finish handler.
				this.loopDetector.record(toolName, args);
				const loopResult = this.loopDetector.check();
				if (loopResult) {
					console.log(`\n[CIRCUIT BREAKER] ${loopResult.message}`);
					this.abort();
				}

				if (success) {
					this.sessionWriter.writeToolResult(
						toolCallId,
						true,
						result.slice(0, 2000),
						durationMs,
						toolName,
						step,
					);
					if (toolName === "write_file" && typeof toolPath === "string") {
						this.sessionWriter.trackFileCreated(toolPath);
					} else if (toolName === "edit_file" && typeof toolPath === "string") {
						this.sessionWriter.trackFileModified(toolPath);
					}
					if (toolName === "git_commit" && result.includes("[")) {
						const commitHash = extractCommitHash(result);
						if (commitHash) this.sessionWriter.trackGitCommit(commitHash);
					}
				} else {
					this.sessionWriter.writeToolError(toolCallId, toolName, result, step);
				}

				this.events.onToolEnd?.({
					toolName,
					toolCallId,
					args,
					success,
					durationMs,
					stepNumber: step,
					resultPreview: result.slice(0, 200),
				});

				return result;
			},
		}));

		// Conversation: the in-place system instructions plus the non-system
		// history (runTextToolAgent injects the tool protocol into the system
		// message itself). Matches the native path's message assembly.
		const history = this.messageHistory
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));
		const messages: Array<{
			role: "system" | "user" | "assistant" | "tool";
			content: string;
		}> = instructions
			? [{ role: "system", content: instructions }, ...history]
			: [...history];

		// One agentic turn against a given local provider/model. The raw call hits
		// the local endpoint with the turn's abort signal wired into fetch, so an
		// abort (timeout / circuit breaker / ESC) tears the request down. Each
		// round is wrapped in withTurnTimeout: a single stalled round (socket
		// accepted, no body - maxRounds bounds round COUNT, not a stuck round)
		// aborts the shared signal and rejects, ending the turn in bounded time
		// instead of hanging for the full session watchdog.
		const attemptTimeoutMs = resolveTurnTimeoutMs();
		const runTurn = (provider: string, model: string) => {
			const rawCall = buildTextToolCall({
				provider,
				model,
				temperature: getRuntimeParams().temperature ?? 0.2,
				signal,
			});
			const call = (msgs: Parameters<typeof rawCall>[0]) =>
				withTurnTimeout(
					() => rawCall(msgs),
					attemptTimeoutMs,
					() => this.abortController?.abort(),
					`${provider}/${model} (text-tools)`,
				);
			return runTextToolAgent({
				messages,
				tools,
				call,
				maxRounds: this.config.maxTurns ?? 6,
				signal,
			});
		};

		let agentResult: Awaited<ReturnType<typeof runTextToolAgent>>;
		try {
			// A missing/unavailable local model must never surface a raw provider
			// 404 (e.g. `ollama chat completions 404: model 'qwen3.6:27b' not
			// found`). callLocalModelWithReroute probes what is actually installed
			// and retries the turn on a real model; only a genuine no-model-anywhere
			// case returns a clean human message.
			const outcome = await callLocalModelWithReroute({
				provider: providerName,
				model: providerModel,
				run: runTurn,
				onReroute: (missing, chosen) => {
					console.log(
						`[reroute] local model "${missing}" is not available; rerouting to "${chosen.model}" (${chosen.provider})`,
					);
				},
			});
			if (!outcome.ok) {
				this.abortController = null;
				this.messageHistory.push({ role: "assistant", content: outcome.message });
				return outcome.message;
			}
			if (outcome.rerouted) {
				// Self-correct the session so subsequent turns skip the dead model
				// instead of paying the failed-request-then-reroute cost every turn.
				this.config.model = outcome.usedModel;
			}
			agentResult = outcome.value;
		} catch (err) {
			// Provider down (ECONNREFUSED -> raw "fetch failed"), a stalled-round
			// timeout, or an abort. Return a friendly turn in the normal chat()
			// shape so the TUI/Pill render it cleanly instead of throwing a raw
			// fetch error up through the surface.
			this.abortController = null;
			const raw = err instanceof Error ? err.message : String(err);
			const endpoint = resolveTextToolEndpoint(providerName);
			const isReachability =
				/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|timed out|ETIMEDOUT|unable to connect|connection refused|failed to connect|able to access the url/i.test(
					raw,
				);
			const friendly = isReachability
				? `The local model endpoint (${endpoint}) is not reachable. Is LM Studio or Ollama running? (${raw})`
				: `The local model turn could not complete: ${raw}`;
			this.messageHistory.push({ role: "assistant", content: friendly });
			return friendly;
		}
		this.abortController = null;

		// Map into the exact shape chat() normally returns: flavored prose, pushed
		// onto the assistant history, with the post-turn bookkeeping the native
		// path performs (session evidence summary, run log, journal).
		const content = agentResult.content;
		const flavor = personalityVoice.getFlavor("complete");
		const flavoredContent = flavorResponse(content, flavor);
		this.messageHistory.push({ role: "assistant", content: flavoredContent });
		this.sessionWriter.writeAssistantContent(stepNumber, [{ type: "text", text: flavoredContent }]);

		const durationSec = Math.round((Date.now() - chatStartTime) / 1000);
		if (this.enableReporting) {
			appendRun({
				ts: new Date().toISOString(),
				status: "ok",
				model: this.config.model,
				dur: durationSec,
				tokens: 0,
				cost: this.totalCost,
				tools: agentResult.toolLog.length,
				created: Array.from(this.sessionWriter.getFilesCreated()),
				modified: Array.from(this.sessionWriter.getFilesModified()),
				session: this.sessionId,
				cwd: this.config.workingDirectory || process.cwd(),
				prompt: textForAgent.slice(0, 120),
			});
		}

		try {
			const _idx = this.turnIndex++;
			await this.turnJournal.write({
				sessionId: this.sessionId,
				turnIndex: _idx,
				startedAt: new Date(chatStartTime).toISOString(),
				finishedAt: new Date().toISOString(),
				input: { role: "user", content: textForAgent },
				systemPromptHash: this.systemPromptHashFull,
				systemPromptLength: this.systemPromptLengthFull,
				toolCalls: agentResult.toolLog.map((e, i) => ({
					id: `tt-${i}`,
					name: e.name,
					args: e.args,
					resultPreview: e.result.slice(0, 200),
					durationMs: 0,
					cached: false,
					redacted: false,
				})),
				modelOutput: {
					content: flavoredContent,
					tokens: { in: 0, out: 0, total: 0 },
				},
				latencyMs: Date.now() - chatStartTime,
				status: "ok",
			});
		} catch {
			/* journal is best-effort; never break the turn */
		}

		return flavoredContent;
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

		// ── Pre-Tool Router (issue #2471) ─────────────────────────────
		// Deterministic harness routing: classify the user's request and
		// pre-fetch the obvious retrieval (ast/grep/glob/vector/fileread)
		// BEFORE the LLM turn. Model-agnostic — small local models get the
		// same correct routing as frontier models. Skipped if the proactive
		// gatherer already injected a clarifying question.
		if (!this.proactiveGatherer) {
			await this.tryRunPreToolRouter(textForAgent);
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

		// Session wall-clock guard: abort if any single turn runs > 30 minutes.
		// Prevents git/shell hangs from silently blocking the agent loop forever.
		const SESSION_MAX_MS = (this.config as any).maxSessionMs ?? 30 * 60 * 1000;
		let sessionWatchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			console.log(
				`\n[8gent] Session watchdog: turn exceeded ${SESSION_MAX_MS / 60000} min — aborting`,
			);
			this.abort();
		}, SESSION_MAX_MS);

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
		// Load computer category when cua:setup has been run, regardless of provider.
		const { existsSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		const cuaConfigured = existsSync(join(homedir(), ".8gent", "cua-configured"));
		if (cuaConfigured) {
			this.toolRegistry.loadCategory("computer");
		}
		const allTools = this.toolRegistry.getTools();
		// When CUA is configured, give a LOCAL provider both the autonomous loop
		// AND the granular desktop_* tools, so it can act directly (screenshot ->
		// click -> type) with the local vision model instead of being stuck behind
		// the cloud-dependent run_computer_task loop. Everything here runs on-device.
		const DESKTOP_TOOLS = [
			"run_computer_task",
			"desktop_screenshot",
			"desktop_click",
			"desktop_type",
			"desktop_press",
			"desktop_scroll",
			"desktop_drag",
			"desktop_hover",
			"desktop_windows",
			"desktop_clipboard",
		];
		const localCoreTools = cuaConfigured ? [...CORE_TOOLS, ...DESKTOP_TOOLS] : CORE_TOOLS;
		const effectiveTools = isLocalProvider
			? Object.fromEntries(Object.entries(allTools).filter(([k]) => localCoreTools.includes(k)))
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

		// ── Text-Tool Routing (local-model agentic tool calling) ──────────
		// A tool-incapable local model (whose served chat template 400s on a
		// native `tools` payload, e.g. some LM Studio GGUF templates) cannot use
		// the AI SDK ToolLoopAgent path below. For those providers we keep tool
		// orchestration in the harness: omit native tools, inject the tool
		// instructions into the system prompt, and parse fenced `tool_call` blocks
		// from the model's plain-text reply. Routing it HERE (the shared chat()
		// method) means the TUI and the Pill/daemon get it automatically, not just
		// the CLI. The native path below is left 100% unchanged for capable
		// providers - this branch only fires behind the needsTextTools gate.
		//
		// The gate mirrors bin/8gent.ts chatCommand: lmstudio/ollama are the
		// tool-incapable local providers (the provider registry's coarse
		// supportsTools flag is true for them, but their GGUF templates reject a
		// tools payload), overridable via EIGHT_TEXT_TOOLS=1|0.
		if (shouldUseTextTools(providerName)) {
			const textResult = await this.runTextToolChat({
				providerName,
				providerModel: providerConfig.model,
				instructions: effectiveInstructions,
				localCoreTools,
				chatStartTime,
				textForAgent,
			});
			if (sessionWatchdog) {
				clearTimeout(sessionWatchdog);
				sessionWatchdog = null;
			}
			return textResult;
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

				// Kernel trace capture (#2752 step 1): buffer this tool step for the
				// current turn's trajectory. No-op unless training_proxy.traceCapture
				// is opted in; scrubbing happens at finalize, before anything is written.
				this.kernel.recordToolStep({
					tool: event.toolName,
					argsSummary: JSON.stringify(event.args ?? {}).slice(0, 300),
					ok: event.success,
					durationMs: event.durationMs,
				});

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
								await memory.remember(fact, layer, {
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
					durationMs: (event as any).durationMs,
					tokensPerSecond: (event as any).tokensPerSecond,
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
					// Time-travel (#2757): checkpoint every N tool calls so
					// "go back to before it broke things" always has a target.
					this.recordToolCallsForTimeTravel(event.toolCalls.length);
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
			// Per-attempt wall-clock bound. Guarantees a single provider.generate()
			// call terminates even when the provider socket stalls (unreachable
			// apple-foundation bridge, an endpoint that accepts but never streams,
			// an invalid model id whose client hangs). On timeout we abort the
			// shared signal and reject; the catch below treats it like any other
			// provider error and advances the bounded failover chain. Once the
			// chain is exhausted the turn throws "All providers exhausted" instead
			// of hanging for the full 30-min session watchdog. Override with
			// EIGHT_TURN_TIMEOUT_MS.
			const attemptTimeoutMs = resolveTurnTimeoutMs();

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
					// Tracks whether THIS attempt's per-attempt timeout fired. When it
					// does we abort the shared signal, so the in-flight generate() may
					// reject with an AbortError that wins the race ahead of our
					// TurnTimeoutError. Without this flag the catch below would treat
					// that AbortError as a user ESC and kill the whole turn.
					let attemptTimedOut = false;
					try {
						// ── Hedge wrap (ISI keystone). When the hedge flag is OFF (default),
						// this fires exactly ONE candidate (the current chain entry) and is
						// byte-identical to a single `agent.generate(...)`. When ON, it fires
						// K free/local-preferred candidates, returns the fastest winner, and
						// writes a dormant winner-vs-loser preference signal to disk. The
						// executor only ever returns ONE result here; tool calls below run for
						// that single result exactly as before, so no loser candidate can ever
						// reach the tool executor.
						const hedge = this.kernel.hedge;
						const candidates: HedgeCandidate[] = [
							{ provider: currentEntry.provider, model: currentEntry.model, local: isLocalProvider },
						];
						if (hedge.enabled) {
							// Add sibling free/local entries from the failover chain as extra
							// candidates. Non-fatal if the chain has no siblings.
							const sibling = failover.resolve(currentEntry.model, channel);
							if (
								sibling.model !== currentEntry.model ||
								sibling.provider !== currentEntry.provider
							) {
								candidates.push({
									provider: sibling.provider,
									model: sibling.model,
									local: false,
								});
							}
						}
						const hedgeOut = await withTurnTimeout(
							() =>
								hedge.run(
									candidates,
									async (cand, signal) => {
										const candAgent =
											cand.provider === currentEntry.provider &&
											cand.model === currentEntry.model
												? agent
												: createEightAgent({
														...agentConfig,
														provider: { name: cand.provider as any, model: cand.model },
													});
										// The agent's GenerateTextResult is structurally a superset of the
										// hedge GenerateResult (it has text + steps); widen for the executor.
										return candAgent.generate({
											messages,
											abortSignal: signal,
										}) as unknown as Promise<
											import("../kernel/hedge-executor").GenerateResult
										>;
									},
									{
										sessionId: this.sessionId,
										turnIndex: this.messageHistory.filter((m) => m.role === "assistant")
											.length,
										prompt: textForAgent,
										abortSignal: this.abortController?.signal,
									},
								),
							attemptTimeoutMs,
							// Abort the shared signal so the stalled request tears down.
							() => {
								attemptTimedOut = true;
								this.abortController?.abort();
							},
							`${currentEntry.provider}/${currentEntry.model}`,
						);
						result = hedgeOut.result;
						resolved = true;
						// Update agentConfig so any downstream logic sees the provider that actually succeeded
						agentConfig =
							hedgeOut.winner.provider === currentEntry.provider &&
							hedgeOut.winner.model === currentEntry.model
								? stepConfig
								: {
										...agentConfig,
										provider: {
											name: hedgeOut.winner.provider as any,
											model: hedgeOut.winner.model,
										},
									};
						break outer;
					} catch (err: any) {
						// A genuine user ESC aborts the controller WITHOUT a per-attempt
						// timeout - re-throw so the turn unwinds. But when OUR timeout
						// fired, the in-flight request may surface as an AbortError that
						// wins the race ahead of the TurnTimeoutError; that is a stalled
						// provider, not a user cancel, so fall through to failover.
						if (err?.name === "AbortError" && !attemptTimedOut) throw err;

						// The shared controller is now aborted (timeout tore it down).
						// Refresh it so the next chain attempt gets a live signal instead
						// of an already-aborted one that would fail instantly.
						if (attemptTimedOut) {
							this.abortController = new AbortController();
						}

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
						if (next.model === currentEntry.model && next.provider === currentEntry.provider) {
							break outer; // chain exhausted
						}
						currentEntry = next;
						break; // exit inner attempt loop, outer reuses new currentEntry
					}
				}
			}

			this.abortController = null;

			if (!resolved) {
				const summary = errors.map((e) => `  - ${e.provider}/${e.model}: ${e.error}`).join("\n");
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
					let retryTimedOut = false;
					try {
						result = await withTurnTimeout(
							() =>
								retryAgent.generate({
									messages: messages2,
									abortSignal: this.abortController?.signal,
								}),
							attemptTimeoutMs,
							() => {
								retryTimedOut = true;
								this.abortController?.abort();
							},
							"retry/maxOutputTokens",
						);
					} catch (retryErr: any) {
						// Only a genuine user ESC (no timeout) re-throws. A timeout-driven
						// abort or any other failure keeps the prior successful result.
						if (retryErr?.name === "AbortError" && !retryTimedOut) throw retryErr;
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

			// Feed successful turn to kernel for personal LoRA training (fire-and-forget).
			// Connector 2 (ISI wiring): score the turn with the PRM judge instead of a
			// hardcoded 0.8. processTurn runs the judge (which redacts + hard-skips on
			// secrets before any cloud call) and returns the real overall score. It
			// returns null when the kernel loop is inactive (flag off / not started),
			// in which case we fall back to the prior neutral 0.8 default so behaviour
			// is unchanged when the flag is OFF. Kept fully off the hot path.
			// Trace capture (#2752 step 1) also routes through here: when only
			// traceCapture is opted in, processTurn still returns null (loop off)
			// and collectSessionTrace persists the scrubbed trajectory locally.
			if (this.kernel.isActive || this.kernel.isEnabled || this.kernel.isTraceCaptureEnabled) {
				const toolCallsSucceeded =
					this.sessionEvidence.filter((e) => !e.verified).length === 0;
				const turnIndex = this.messageHistory.filter((m) => m.role === "assistant").length;
				const promptForKernel = textForAgent;
				const responseForKernel = flavoredContent;
				const modelForKernel = this.config.model;
				// Fire-and-forget: judge scores async, never blocks the turn.
				void this.kernel
					.processTurn(
						this.sessionId,
						turnIndex,
						modelForKernel,
						promptForKernel,
						responseForKernel,
					)
					.then((record) => {
						const score = record?.scores.overall ?? 0.8;
						this.kernel.collectSessionTrace(
							this.sessionId,
							promptForKernel,
							responseForKernel,
							score,
							{
								model: modelForKernel,
								toolCallsSucceeded,
								userCorrected: false,
								turnIndex,
							},
						);
					})
					.catch(() => {
						// Judge unavailable: fall back to the neutral default, never block.
						this.kernel.collectSessionTrace(
							this.sessionId,
							promptForKernel,
							responseForKernel,
							0.8,
							{ model: modelForKernel, toolCallsSucceeded, userCorrected: false, turnIndex },
						);
					});
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

			// Two-stage compactor (#2467) — additive to the legacy ProactiveCompression
			// above. Cheap checkpoint at 65%, hard compact at 80%. Provider context
			// size resolved per-provider; defaults applied conservatively when the
			// provider definition does not expose contextSize.
			if (process.env["8GENT_TWO_STAGE_COMPACT"] !== "0") {
				try {
					if (!this.twoStageCompactor) {
						const summarizer: Summarizer = async (msgs) => {
							const compactModel = createModel(providerConfig);
							const serialised = msgs
								.map((m) => `[${m.role}]: ${m.content.slice(0, 1500)}`)
								.join("\n\n");
							const { generateText } = await import("ai");
							const { text } = await generateText({
								model: compactModel,
								prompt: `Summarise the following conversation into a concise structured checkpoint another agent can resume from. Preserve file paths, function names, and decisions verbatim.\n\n<conversation>\n${serialised}\n</conversation>\n\n## Goal\n## Progress\n## Decisions\n## Next Steps`,
								maxOutputTokens: 800,
							});
							return text;
						};
						this.twoStageCompactor = new TwoStageCompactor({
							checkpointPct: 0.65,
							compactPct: 0.8,
							keepLastN: 4,
							summarizer,
						});
					}
					const ctxSize =
						(providerConfig as unknown as { contextSize?: number }).contextSize ?? 32_768;
					const state: TwoStageAgentState = {
						messages: this.messageHistory,
						checkpoints: this.twoStageCheckpoints,
						provider: { contextSize: ctxSize },
					};
					const result = await this.twoStageCompactor.observe(state);
					if (result.action !== "none") {
						console.log(
							`  [TWO_STAGE:${result.action}] tokens ${result.report?.tokensBefore} -> ${result.report?.tokensAfter}, removed ${result.report?.messagesRemoved}`,
						);
					}
				} catch (err) {
					console.error("  [TWO_STAGE] Failed:", (err as Error).message);
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

			if (sessionWatchdog) {
				clearTimeout(sessionWatchdog);
				sessionWatchdog = null;
			}
			// TurnJournal (#2470): per-turn replayable record. Last line of the
			// post-turn block so any compactor.observe() / router work upstream
			// has already settled. Best-effort: never block the return.
			try {
				const _idx = this.turnIndex++;
				const _now = new Date().toISOString();
				await this.turnJournal.write({
					sessionId: this.sessionId,
					turnIndex: _idx,
					startedAt: new Date(chatStartTime).toISOString(),
					finishedAt: _now,
					input: { role: "user", content: textForAgent },
					systemPromptHash: this.systemPromptHashFull,
					systemPromptLength: this.systemPromptLengthFull,
					toolCalls: [],
					modelOutput: {
						content: flavoredContent,
						tokens: { in: 0, out: 0, total: totalTokensUsed },
					},
					latencyMs: Date.now() - chatStartTime,
					status: "ok",
				});
			} catch {
				/* journal is best-effort; never break the turn */
			}
			return flavoredContent;
		} catch (err) {
			if (sessionWatchdog) {
				clearTimeout(sessionWatchdog);
				sessionWatchdog = null;
			}
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

			// TurnJournal (#2470): partial record for errored turn so audit + replay
			// can reconstruct what blew up. Best-effort.
			try {
				const _idx = this.turnIndex++;
				await this.turnJournal.write({
					sessionId: this.sessionId,
					turnIndex: _idx,
					startedAt: new Date(chatStartTime).toISOString(),
					finishedAt: new Date().toISOString(),
					input: { role: "user", content: textForAgent },
					systemPromptHash: this.systemPromptHashFull,
					systemPromptLength: this.systemPromptLengthFull,
					toolCalls: [],
					modelOutput: {
						content: "",
						tokens: { in: 0, out: 0, total: totalTokensUsed },
					},
					latencyMs: Date.now() - chatStartTime,
					status: "errored",
					error: errMsg.slice(0, 500),
				});
			} catch {
				/* journal is best-effort */
			}

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
	 * Time-travel interval policy (#2757): count executed tool calls and cut
	 * a content-addressed checkpoint every EIGHT_CHECKPOINT_EVERY calls
	 * (default 8, 0 disables). Deduped blobs make repeat saves near-free.
	 * Never throws into the agent loop: a failed checkpoint is logged and
	 * the turn continues.
	 */
	private recordToolCallsForTimeTravel(count: number): void {
		const every = checkpointEveryFromEnv();
		if (every === 0) return;
		this.timeTravelToolCallsSinceCheckpoint += count;
		this.timeTravelTotalToolCalls += count;
		if (this.timeTravelToolCallsSinceCheckpoint < every) return;
		this.timeTravelToolCallsSinceCheckpoint = 0;
		try {
			if (!this.timeTravelStore) this.timeTravelStore = new TimeTravelStore();
			const meta = this.timeTravelStore.save(this.sessionId, this.getMessageHistory(), {
				reason: "interval",
				toolCallCount: this.timeTravelTotalToolCalls,
			});
			console.log(
				`  [TIME_TRAVEL] checkpoint ${meta.id} at ${meta.toolCallCount} tool calls (${meta.newBlobs} new blobs)`,
			);
		} catch (err) {
			console.error("  [TIME_TRAVEL] checkpoint failed:", (err as Error).message);
		}
	}

	/** Time-travel store for this session (rewind/fork verbs build on this). */
	getTimeTravelStore(): TimeTravelStore {
		if (!this.timeTravelStore) this.timeTravelStore = new TimeTravelStore();
		return this.timeTravelStore;
	}

	/** The session id this agent's time-travel checkpoints are stored under. */
	getTimeTravelSessionId(): string {
		return this.sessionId;
	}

	/** All time-travel checkpoints for this agent's session, oldest first. */
	listTimeTravelCheckpoints(): CheckpointMeta[] {
		return this.getTimeTravelStore().list(this.sessionId);
	}

	/**
	 * Time-travel rewind verb (#2757, step 2). Goes back `steps` checkpoints
	 * from the latest (steps=0 restores the latest checkpoint itself) and
	 * replaces the live message history with that state. Returns the restored
	 * checkpoint, or null when the session has no checkpoint that far back.
	 */
	rewindTimeTravel(steps = 1): RestoredCheckpoint | null {
		const restored = this.getTimeTravelStore().rewind(this.sessionId, steps);
		if (!restored) return null;
		this.restoreFromCheckpoint(restored.messages);
		console.log(
			`  [TIME_TRAVEL] rewound ${steps} step(s) to checkpoint ${restored.meta.id} (${restored.meta.messageCount} messages)`,
		);
		return restored;
	}

	/**
	 * Time-travel fork verb (#2757, step 2). Starts this agent's lineage from
	 * a checkpoint of another session (zero blobs copied - content-addressed)
	 * and restores that state into the live message history. The two sessions
	 * then diverge independently: explore two fixes from the same state.
	 */
	adoptTimeTravelFork(sourceSessionId: string, checkpointId: string): RestoredCheckpoint {
		const store = this.getTimeTravelStore();
		const meta = store.fork(sourceSessionId, checkpointId, this.sessionId);
		const { messages } = store.load(this.sessionId, meta.id);
		this.restoreFromCheckpoint(messages);
		console.log(
			`  [TIME_TRAVEL] forked from ${sourceSessionId}/${checkpointId} into ${this.sessionId} (${messages.length} messages)`,
		);
		return { meta, messages };
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

		// Write session to Knowledge Graph (fire-and-forget, best-effort)
		const allModified = [
			...this.sessionWriter.getFilesCreated(),
			...this.sessionWriter.getFilesModified(),
		];
		writeSessionToKG({
			sessionId: this.sessionId,
			summary: generateSessionSummary(this.messageHistory, allModified),
			cwd: this.config.workingDirectory || process.cwd(),
			filesCreated: this.sessionWriter.getFilesCreated(),
			filesModified: this.sessionWriter.getFilesModified(),
			durationMs: Date.now() - this.sessionStartTime,
			branch: null,
		}).catch(() => {});

		const manager = getLSPManager();
		await manager.stopAll();
	}

	/**
	 * Pre-Tool Router (issue #2471) — model-agnostic deterministic routing.
	 *
	 * Classifies the user's request and, if confidence > 0.6, runs the
	 * implied retrieval through the existing tool dispatch path so the
	 * SecretScanner (and Wave 2 Cache + ArtifactStore wrappers) apply.
	 * The result is injected as a system message before the LLM turn.
	 *
	 * Failures are swallowed: routing is a best-effort optimisation, not
	 * a hard dependency of the agent loop.
	 */
	private async tryRunPreToolRouter(userMessage: string): Promise<void> {
		const cwd = this.config.workingDirectory || process.cwd();
		let decision: RouterDecision;
		try {
			decision = this.preToolRouter.classify(userMessage, { cwd });
		} catch {
			return;
		}
		if (decision.strategy === "none" || decision.confidence <= 0.6) return;

		const dispatch = mapStrategyToTool(decision);
		if (!dispatch) return;

		try {
			const result = await this.executor.execute(dispatch.tool, dispatch.args);
			if (!result || result.length === 0) return;
			this.messageHistory.push({
				role: "system",
				content: formatPreFetchedContext(decision, result),
			});
		} catch {
			// Silent: pre-fetch is best-effort.
		}
	}
}

/**
 * Map a router decision to a tool name + args understood by ToolExecutor.
 * Centralised here so the strategy taxonomy stays in pre-tool-router.ts and
 * the dispatch concerns stay in agent.ts.
 */
function mapStrategyToTool(
	decision: RouterDecision,
): { tool: string; args: Record<string, unknown> } | null {
	switch (decision.strategy) {
		case "ast": {
			const symbol = String(decision.args.symbol ?? "");
			if (!symbol) return null;
			return { tool: "search_symbols", args: { query: symbol } };
		}
		case "grep": {
			const pattern = String(decision.args.pattern ?? "");
			if (!pattern) return null;
			// Quote the pattern; rely on rg if present, else grep -RIn.
			const safe = pattern.replace(/(["\\$`])/g, "\\$1");
			const cmd = `command -v rg >/dev/null 2>&1 && rg -n --no-heading "${safe}" || grep -RInE "${safe}" .`;
			return { tool: "run_command", args: { command: cmd } };
		}
		case "glob": {
			const pattern = String(decision.args.pattern ?? "");
			if (!pattern) return null;
			return { tool: "list_files", args: { pattern } };
		}
		case "vector": {
			const query = String(decision.args.query ?? "");
			if (!query) return null;
			return { tool: "recall", args: { query } };
		}
		case "fileread": {
			const filePath = String(decision.args.path ?? "");
			if (!filePath) return null;
			return { tool: "read_file", args: { path: filePath } };
		}
		default:
			return null;
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
