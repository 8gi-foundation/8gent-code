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
import { ensureIndexed as astEnsureIndexed } from "../ast-index";
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
import { AgentDepthError, processAgentDepthRefusal } from "../orchestration/index";
import { type OrchestratorBus, getOrchestratorBus } from "../orchestration/orchestrator-bus";
import { forceLocalModel, privacyGate } from "../permissions/privacy-router";
import { startSystemOneWarmup } from "../permissions/system-one-gate";
import { effectivePermissionMode, systemOneEnvFor } from "../permissions/permission-mode";
import { type ProactivePlanner, getProactivePlanner } from "../planning/proactive-planner";
import { type FailoverEntry, ModelFailover } from "../providers/failover";
import { callLocalModelWithReroute, resolveToolCapableModel } from "../providers/model-reroute";
import { getProviderManager, type ProviderName as ProviderRegistryName } from "../providers";
import { capabilityToolMode, knownContextWindow } from "../orchestration/local-model-detect";
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
import { type ToolLedgerEntry, enforceAgenticHonesty, isErrorToolResult } from "./honesty";
import { projectInstructionsSection } from "./instruction-loader";
import { isLocalProvider } from "./registry";
import { PreToolRouter, type RouterDecision, formatPreFetchedContext } from "./pre-tool-router";
import { DEFAULT_SYSTEM_PROMPT, PLANNING_GATE_INSTRUCTION } from "./prompt";
import { ORCHESTRATOR_SEGMENT, buildOrchestratorContext } from "./prompts/orchestrator-prompt";
import { buildToolCatalogSegment } from "./prompts/system-prompt";
import { localCatalogOmissions, localDelegationTools } from "./local-tool-scope";
import { SessionSyncManager } from "./session-sync";
import {
	type CheckpointMeta,
	type RestoredCheckpoint,
	TimeTravelStore,
	checkpointEveryFromEnv,
} from "./timetravel/checkpoint-store";
import { ToolLoopDetector } from "./tool-loop-detector";
import { ToolRegistry, getDeferredToolSegment } from "./tool-registry";
import { ToolExecutor } from "./tools";
import { TurnJournal } from "./turn-journal";
import { providerConfigForStep } from "./failover-provider-config";
import { describeLocalTurnFailure, failedTurnRunEntry } from "./local-turn-error";
import { resolveTurnTimeoutMs, withTurnTimeout } from "./turn-timeout";
import {
	type CheckpointEntry,
	type Summarizer,
	type AgentState as TwoStageAgentState,
	TwoStageCompactor,
	twoStageCheckpointPrompt,
} from "./two-stage-compactor";
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
	COMPLETION_PHRASES,
	ERROR_PHRASES,
	GREETINGS,
	PERSONALITY,
	flavorResponse,
	voice as personalityVoice,
} from "../personality/voice.js";
import { type SentSections, contextNote, harnessNote } from "./context-note";

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
	createRuntimeParams,
	getRuntimeParams,
} from "../ai";
import {
	type TextTool,
	batchSkipToolEvents,
	buildTextToolCall,
	needsTextTools,
	resolveTextToolEndpoint,
	runTextToolAgent,
	toOpenAiV1Base,
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
export function shouldUseTextTools(providerName: string, scoped = false): boolean {
	// An edit scope (allowedPaths) is enforced only by the text-path executor
	// (ToolExecutor). The native AI SDK tools share one process-wide context, so
	// they cannot hold a per-agent scope; a scoped agent never runs on them,
	// whatever EIGHT_TEXT_TOOLS says.
	if (scoped) return true;
	const override = (process.env.EIGHT_TEXT_TOOLS || "").trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	// llama-server (#3149) is a local server like the other two: the harness's
	// text-tool protocol, not the SDK's native tool loop.
	const supportsNativeTools =
		providerName !== "lmstudio" && providerName !== "ollama" && providerName !== "llama-server";
	return needsTextTools({ supportsNativeTools });
}

/**
 * The operator's pinned model (`~/.8gent/providers.json` activeModel), used as
 * the first preference when an agentic turn must be routed off a model that
 * cannot accept tools (Law 2, issue #2747).
 */
function readPinnedActiveModel(): string[] {
	try {
		const raw = fs.readFileSync(path.join(os.homedir(), ".8gent", "providers.json"), "utf-8");
		const parsed = JSON.parse(raw) as { activeModel?: string };
		return typeof parsed.activeModel === "string" && parsed.activeModel ? [parsed.activeModel] : [];
	} catch {
		return [];
	}
}

export class Agent {
	private executor: ToolExecutor;
	private config: AgentConfig;
	/** This agent's own runtime params: self_tune on another agent never reaches them (#3140). */
	private runtimeParams = createRuntimeParams();
	// Session context kept out of the system prompt (#3222): the memories fixed
	// at build, what was last sent per section, and the notes that carried it.
	private sessionMemoryContext = "";
	private contextSent: SentSections = {};
	private contextNoteMessages: Array<{ role: string; content: string }> = [];
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
	/** The active provider's known context window (SPEC-05), shared by both compactors (#3237). */
	private compactionContextWindow: number;
	// Time-travel (#2757): content-addressed checkpoints every N tool calls.
	// Lazily constructed so sessions that never call a tool pay nothing.
	private timeTravelStore: TimeTravelStore | null = null;
	private timeTravelToolCallsSinceCheckpoint = 0;
	private timeTravelTotalToolCalls = 0;
	private recentFilePaths: string[] = [];
	// Per-turn tool ledger: every tool call this turn with its real success
	// state. The agentic-honesty gate (issue #2747) checks the final reply
	// against this so the agent can never claim completion it did not earn.
	private turnToolLedger: ToolLedgerEntry[] = [];
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
		// Backstop for #3341: no model loop in a process past MAX_AGENT_DEPTH,
		// whichever entrypoint built it. Reads the PROCESS depth only, so an
		// in-process pool child at MAX (bound by runAtAgentDepth) still runs.
		const depthRefusal = processAgentDepthRefusal();
		if (depthRefusal) throw new AgentDepthError(depthRefusal);
		this.config = config;
		this.events = config.events || {};
		this.executor = new ToolExecutor(
			config.workingDirectory || process.cwd(),
			config.agentScope ?? "primary",
			undefined,
			{
				unattended: config.unattended ?? false,
				allowedPaths: config.allowedPaths,
				openOnWrite: config.openOnWrite ?? true,
				permission: config.permission,
			},
		);
		// System One (on by default, EIGHT_SYSTEM_ONE=0 off): with the allowlist
		// opted out, start loading the judge now, in the background, so the
		// first gated command does not pay the model load. Idempotent per
		// process; allowlist on (the default) or System One off, it is a no-op.
		// Guarded mode (#3170) turns System One on for this agent's calls, so
		// it warms the judge too.
		startSystemOneWarmup(
			systemOneEnvFor(config.permission ? effectivePermissionMode(config.permission) : undefined),
		)?.catch(() => {});
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

		// Initialize deferred tool registry (allTools flag loads everything upfront)
		this.toolRegistry = new ToolRegistry(config.allTools ?? false);
		// SPEC-05 #108: feed the ACTIVE provider's detected context window into
		// compaction instead of the hardcoded 32k. A large-context cloud model
		// (e.g. anthropic 200k) compacts far later; a small local model compacts
		// sooner. Falls back to the conservative floor for unknown providers.
		const compactionContextWindow = knownContextWindow(
			getProviderManager().getProvider(config.runtime as ProviderRegistryName),
		);
		this.compaction = new ProactiveCompression({ contextWindow: compactionContextWindow });
		this.compactionContextWindow = compactionContextWindow;

		// Two-stage compactor (issue #2467). Layered alongside ProactiveCompression
		// rather than replacing it: the legacy single-threshold engine still
		// guards hard limits; the two-stage path produces cheap mid-pressure
		// checkpoints so context loss is gradual instead of cliff-edged.
		// Summariser is a thin wrapper around the active provider's chat client;
		// constructed lazily on first observe so providerConfig is in scope.
		this.twoStageCompactor = null;

		// AST index for AST-first retrieval. ensureIndexed returns the build the
		// ToolExecutor above already started for this folder, so this only
		// attaches the debug log; it never indexes the repo a second time.
		const cwd = config.workingDirectory || process.cwd();
		if (!LITE) {
			astEnsureIndexed(cwd)
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

		// Inject the 8gent personality voice into the system prompt. Fixed phrases,
		// never a random pick: a different phrase per build changed the prompt at
		// byte 17,318 and cost the whole prefix cache (#3222).
		const personalityBlock = `\n\n## PERSONALITY VOICE: ${BRAND.fullName}: ${PERSONALITY.tagline}
You are ${PERSONALITY.name}, the infinite gentleman agent coder.
Traits: refined, witty, confident, helpful, endlessly capable.
When greeting users, use phrases like: "${GREETINGS[0]}"
When completing tasks, use phrases like: "${COMPLETION_PHRASES[0]}"
When encountering errors, stay composed: "${ERROR_PHRASES[0]}"
Maintain a tone that is sophisticated yet approachable, like a well-dressed engineer who happens to be brilliant.\n`;

		// Inject orchestrator awareness into system prompt
		const orchestratorBlock = `\n\n${ORCHESTRATOR_SEGMENT}`;

		// Inject vessel context if running as a deployed instance (set by daemon at startup)
		const vesselContext = process.env.EIGHT_VESSEL_CONTEXT
			? `\n\n${process.env.EIGHT_VESSEL_CONTEXT}`
			: "";

		// Inject deferred tool categories when not loading all tools upfront
		const deferredToolBlock = config.allTools ? "" : `\n\n${getDeferredToolSegment()}`;

		// Prior session context and global user memories (best-effort, sync).
		// They differ per session, so they travel as a context message after the
		// system prompt, never inside it (#3222). Table officers never get them.
		const priorSessionsBlock = recallPriorSessionsSync(config.workingDirectory || process.cwd());
		const globalMemoriesBlock = recallGlobalMemoriesSync();
		this.sessionMemoryContext =
			config.agentScope === "__table__" ? "" : globalMemoriesBlock + priorSessionsBlock;

		// Local providers have limited context windows — use a compact prompt that
		// still includes an honest tool catalog so the model never claims it has
		// no tools / no internet when it actually does. Closes #1082.
		// Capability gate (SPEC-05 #108): the compact local prompt is for providers
		// whose tool pathway is text-protocol or none, not a hardcoded name list.
		// A capable cloud provider gets the full prompt; Ollama-served 8gent GGUFs
		// stay on the compact path via their text-tool capability.
		const runtimeName = this.config.runtime as string;
		const runtimeCaps = getProviderManager().getProvider(runtimeName as ProviderRegistryName);
		const isLocalRuntime = capabilityToolMode(runtimeCaps) !== "native";
		const compactLocalPrompt = `You are 8gent, an autonomous coding agent. Use tools to read, write, edit, run commands, and search the web. Be concise. Never claim you cannot do something until you have tried the relevant tool.\n\nCRITICAL: When the user shares ANY personal fact (name, preferences, habits, goals), IMMEDIATELY call the \`remember\` tool with layer \`global\`. Do not wait to be asked.\n\n${buildToolCatalogSegment({ concise: true, omit: localCatalogOmissions(config.role) })}`;

		// A Table officer's system prompt is SUPPLIED by the daemon (persona plus
		// the capability truth for a chat-channel colleague) and must be used
		// verbatim. The isLocalRuntime branch below swaps in compactLocalPrompt,
		// which silently DISCARDED config.systemPrompt for every officer on
		// lmstudio/ollama - i.e. six of the eight. Measured 2026-08-06 with a
		// sentinel persona: the persona never reached the model, and what did
		// reach it was "You are 8gent, an autonomous coding agent. Use tools to
		// read, write, edit, run commands", a tool catalog advertising
		// write_file/run_command/web_search, and the operator's private global
		// memories. One line, four observed pathologies: indistinguishable
		// personas (there was no persona), officers claiming tools they do not
		// have (they were advertised), "never claim you cannot do something"
		// pushing them to fabricate, and private-memory leakage into an
		// untrusted channel. Table sessions bypass it.
		const isTableScope = config.agentScope === "__table__";
		// Project instructions (AGENTS.md / 8GENT.md / CLAUDE.md) reach the model
		// on both coding paths (#3236), as the trailing section so the prefix
		// before it stays stable (#3222). Table officers keep their supplied
		// prompt verbatim, for the reasons above.
		// The operator's user-global files (~/.claude/CLAUDE.md, ~/.8gent, a
		// ~/AGENTS.md) go only to an on-box model; a cloud provider gets the
		// project's files alone (8SO, #3236).
		const projectInstructionsBlock = isTableScope
			? ""
			: projectInstructionsSection(config.workingDirectory || process.cwd(), {
					includeUserGlobal: runsOnBox(runtimeName, config.baseUrl),
				});
		this.messageHistory.push({
			role: "system",
			content: isTableScope
				? basePrompt + languageInstruction
				: isLocalRuntime
				? compactLocalPrompt + projectInstructionsBlock
				: basePrompt +
					vesselContext +
					userContextBlock +
					personalityBlock +
					orchestratorBlock +
					deferredToolBlock +
					languageInstruction +
					projectInstructionsBlock,
		});

		// Initialize session persistence (v2)
		this.sessionWriter = new SessionWriter(this.sessionId);
		// A Table officer is a colleague in a chat channel, not the orchestrator of a
		// coding session. Appending the orchestrator/personality blocks told every
		// officer "You are the orchestrator, you can spawn specialists" and re-listed
		// capabilities they do not have - drowning their own persona + honesty rules
		// and producing rigid "PLAN: 1. 2. 3." replies with fake shell blocks. Table
		// sessions therefore use their supplied prompt VERBATIM.
		const systemPromptFull =
			this.config.agentScope === "__table__"
				? basePrompt + languageInstruction
				: basePrompt + userContextBlock + personalityBlock + orchestratorBlock + languageInstruction;
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
	 * payload, except Ollama, where the tools are declared so native calls its
	 * parser accepts come back as tool_calls), and emits the same onToolStart/onToolEnd events the native path
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
					success = !isErrorToolResult(result);
				} catch (err) {
					success = false;
					result = `Error running tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`;
				}

				const durationMs = Date.now() - startedAt;

				// Honesty ledger (issue #2747): record the REAL outcome so the final
				// reply can be gated against what actually happened.
				this.turnToolLedger.push({ name: toolName, args, success, result: result.slice(0, 500) });

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
		}> = instructions ? [{ role: "system", content: instructions }, ...history] : [...history];

		// One agentic turn against a given local provider/model. The raw call hits
		// the local endpoint with the turn's abort signal wired into fetch, so an
		// abort (timeout / circuit breaker / ESC) tears the request down. Each
		// round is wrapped in withTurnTimeout: a single stalled round (socket
		// accepted, no body - maxRounds bounds round COUNT, not a stuck round)
		// aborts the shared signal and rejects, ending the turn in bounded time
		// instead of hanging for the full session watchdog.
		const attemptTimeoutMs = resolveTurnTimeoutMs();
		// #2805: the OpenAI-compatible local endpoints (ollama, LM Studio) report
		// REAL usage on each completion. Forward it through onStepFinish so
		// consumers (harness StatusEvent.tokens, TUI totals) see real token
		// counts on the text-tool path too, and accumulate the turn totals for
		// the run log + journal. Nothing fires when the endpoint omits usage -
		// no fabricated numbers, ever.
		let usageStepNumber = 0;
		const usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		const runTurn = (provider: string, model: string) => {
			const rawCall = buildTextToolCall({
				provider,
				model,
				// Honour this session's pinned local endpoint (e.g. a Table officer on
				// a specific port). Suffix-reconciled inside resolveTextToolEndpoint,
				// so lmstudio (no /v1) and apfel (/v1) bases both land correctly.
				baseUrl: this.config.baseUrl,
				temperature: this.runtimeParams.temperature ?? 0.2,
				signal,
				// Same limit as withTurnTimeout below, so EIGHT_TURN_TIMEOUT_MS is the
				// only thing that bounds a model step (never Bun's hidden 300 s cap).
				timeoutMs: attemptTimeoutMs,
				// Declared to Ollama so a native tool call its parser accepts comes
				// back in message.tool_calls instead of being silently dropped.
				tools: tools.map((t) => t.spec),
				onUsage: (usage) => {
					usageTotals.promptTokens += usage.promptTokens;
					usageTotals.completionTokens += usage.completionTokens;
					usageTotals.totalTokens += usage.totalTokens;
					this.events.onStepFinish?.({
						stepNumber: usageStepNumber++,
						finishReason: "stop",
						text: "",
						toolCalls: [],
						usage,
					});
				},
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
				// Batch trial (EIGHT_RUN_BATCH=1, #3502): show skipped calls as one
				// failed tool line through the existing events. Never fires flag off.
				onCallsSkipped: (e) => {
					const { start, end } = batchSkipToolEvents(e, `tt-skip-${Date.now()}-${stepNumber}`, stepNumber);
					this.events.onToolStart?.(start);
					this.events.onToolEnd?.(end);
				},
			});
		};

		// ── Law 2 (issue #2747): only tool-capable models do tool-work ──────
		// This turn has tools in play. Verify (once, cached) that the pinned
		// local model actually accepts a NATIVE `tools` payload; a model that
		// 400s the probe (broken jinja chat template, e.g. gemma missing
		// format_type_argument) fabricates instead of executing, so the agentic
		// turn is routed to a model that can act - preferring the operator's
		// ~/.8gent/providers.json pin (ornith).
		//
		// Table sessions are EXEMPT from this reroute. We are already inside
		// runTextToolChat precisely because this provider does not get the AI
		// SDK's native tool loop (shouldUseTextTools gates on providerName ===
		// lmstudio/ollama) - tool orchestration here is the harness's OWN
		// text-protocol (fenced tool_call blocks parsed from plain text), which
		// never sends a native `tools` payload at all. So probing NATIVE payload
		// acceptance is the wrong question for this path, and silently acting on
		// a "no" answer overrode a Table officer's explicitly configured
		// model/persona (bound in agent-pool.createSession from
		// packages/table/officers.ts / table-officers.json overrides) with
		// whatever happened to be pinned in ~/.8gent/providers.json - defeating
		// the entire point of "/officer <code> model <name>" per-officer config.
		// Measured 2026-08-06: gemma-4-12b-coder-fable5-composer2.5-v1 (8TO/8PO/
		// 8CO's configured model) 400s this probe every time (broken jinja
		// template); ornith-1.0-9b (the providers.json pin) passes it - so every
		// gemma-pinned officer was silently rerouted to ornith on its very first
		// Table turn. A Table officer's tool surface is also a small, fixed,
		// read-only text-tool set (read_file, list_files, get_outline,
		// get_symbol, search_symbols, recall - see TABLE_SESSION_TOOLS above), so
		// there is no genuine capability gap this gate protects against here.
		const isTableSession = this.config.agentScope === "__table__";
		let effectiveProvider = providerName;
		let effectiveModel = providerModel;
		if (!isTableSession) {
			try {
				const resolution = await resolveToolCapableModel({
					provider: providerName,
					model: providerModel,
					prefer: readPinnedActiveModel(),
				});
				if (resolution.switched) {
					console.log(`[honesty] ${resolution.reason}`);
					effectiveProvider = resolution.provider;
					effectiveModel = resolution.model;
					this.emitModelRouted(providerModel, resolution.model, resolution.provider);
					// Session self-correction: subsequent turns start on the capable model.
					this.config.model = resolution.model;
				}
			} catch {
				// The capability gate is best-effort - it must never block a turn.
			}
		}

		// A turn that ends in an error is still a run: record it in runs.jsonl
		// with status "error" and the reason, like a successful turn records "ok".
		const recordFailedRun = (reason: string) => {
			if (!this.enableReporting) return;
			try {
				appendRun(
					failedTurnRunEntry({
						model: this.config.model,
						startedAt: chatStartTime,
						tokens: usageTotals.totalTokens,
						cost: this.totalCost,
						tools: this.turnToolLedger.length,
						created: Array.from(this.sessionWriter.getFilesCreated()),
						modified: Array.from(this.sessionWriter.getFilesModified()),
						session: this.sessionId,
						cwd: this.config.workingDirectory || process.cwd(),
						prompt: textForAgent,
						reason,
					}),
				);
			} catch {
				// The run log is best-effort; it must never mask the turn's reply.
			}
		};

		let agentResult: Awaited<ReturnType<typeof runTextToolAgent>>;
		try {
			// A missing/unavailable local model must never surface a raw provider
			// 404 (e.g. `ollama chat completions 404: model 'qwen3.6:27b' not
			// found`). callLocalModelWithReroute probes what is actually installed
			// and retries the turn on a real model; only a genuine no-model-anywhere
			// case returns a clean human message.
			const outcome = await callLocalModelWithReroute({
				provider: effectiveProvider,
				model: effectiveModel,
				run: runTurn,
				onReroute: (missing, chosen) => {
					console.log(
						`[reroute] local model "${missing}" is not available; rerouting to "${chosen.model}" (${chosen.provider})`,
					);
					this.emitModelRouted(missing, chosen.model, chosen.provider);
				},
			});
			if (!outcome.ok) {
				this.abortController = null;
				this.messageHistory.push({ role: "assistant", content: outcome.message });
				recordFailedRun(`no local model: ${outcome.message}`);
				return outcome.message;
			}
			if (outcome.rerouted) {
				// Self-correct the session so subsequent turns skip the dead model
				// instead of paying the failed-request-then-reroute cost every turn.
				this.config.model = outcome.usedModel;
			}
			agentResult = outcome.value;
		} catch (err) {
			// Provider down (ECONNREFUSED -> raw "fetch failed"), a model step
			// that ran past EIGHT_TURN_TIMEOUT_MS, or an abort. Return a friendly
			// turn in the normal chat() shape so the TUI/Pill render it cleanly
			// instead of throwing a raw fetch error up through the surface. A slow
			// model is a timeout, not "not reachable" - they have different fixes.
			this.abortController = null;
			const endpoint = resolveTextToolEndpoint(providerName, this.config.baseUrl);
			const failure = describeLocalTurnFailure(err, { endpoint, timeoutMs: attemptTimeoutMs });
			this.messageHistory.push({ role: "assistant", content: failure.message });
			recordFailedRun(failure.reason);
			return failure.message;
		}
		this.abortController = null;

		// ── Law 1 (issue #2747): no fabricated completion ────────────────────
		// The final reply is gated on the turn's tool ledger. A completion claim
		// with no successful action-tool call behind it is replaced with an
		// honest report of what actually happened (the real tool error, or the
		// fact that nothing ran at all).
		const gated = enforceAgenticHonesty({
			content: agentResult.content,
			ledger: this.turnToolLedger,
			workingDirectory: this.config.workingDirectory || process.cwd(),
		});
		if (gated.violated) {
			console.log(`[honesty] blocked fabricated completion: ${gated.reason}`);
		}

		// Map into the exact shape chat() normally returns: flavored prose, pushed
		// onto the assistant history, with the post-turn bookkeeping the native
		// path performs (session evidence summary, run log, journal). A reply the
		// honesty gate rewrote is NOT flavored - no celebration on a failure.
		const content = gated.content;
		const flavor = personalityVoice.getFlavor("complete");
		// Never flavor a Table reply. The officer speaking is Karen or Rishi, not
		// 8gent, and flavorResponse staples a random COMPLETION_PHRASE ("Consider
		// it done. Magnificently.", "As expected, excellence prevails.") onto
		// every third reply. In a channel that reads as a fabricated completion
		// claim - it appeared verbatim in the live corpus attached to an honest
		// refusal, directly undercutting the sentence before it. Those taglines
		// were previously assumed to be an emergent tic of the small local
		// models; they are packages/personality/voice.ts, appended right here.
		// Same for a reply carrying "[harness] Not verified" lines: the tool log
		// contradicts part of it, so no completion tagline goes on the end.
		const flavoredContent =
			gated.violated || agentResult.unverified.length > 0 || this.config.agentScope === "__table__"
				? content
				: flavorResponse(content, flavor);
		this.messageHistory.push({ role: "assistant", content: flavoredContent });
		this.sessionWriter.writeAssistantContent(stepNumber, [{ type: "text", text: flavoredContent }]);

		const durationSec = Math.round((Date.now() - chatStartTime) / 1000);
		if (this.enableReporting) {
			appendRun({
				ts: new Date().toISOString(),
				status: "ok",
				model: this.config.model,
				dur: durationSec,
				// Real accumulated usage from the endpoint (0 only when the
				// endpoint reported none) - see #2805.
				tokens: usageTotals.totalTokens,
				cost: this.totalCost,
				tools: agentResult.toolLog.length,
				created: Array.from(this.sessionWriter.getFilesCreated()),
				modified: Array.from(this.sessionWriter.getFilesModified()),
				session: this.sessionId,
				cwd: this.config.workingDirectory || process.cwd(),
				prompt: textForAgent.slice(0, 120),
				...(agentResult.unverified.length > 0 ? { unverified: agentResult.unverified } : {}),
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
					// Real accumulated usage from the endpoint (zeros only when the
					// endpoint reported none) - see #2805.
					tokens: {
						in: usageTotals.promptTokens,
						out: usageTotals.completionTokens,
						total: usageTotals.totalTokens,
					},
				},
				latencyMs: Date.now() - chatStartTime,
				status: "ok",
			});
		} catch {
			/* journal is best-effort; never break the turn */
		}

		return flavoredContent;
	}

	/**
	 * Append a context message when memories, self-appended context or voice
	 * mode differ from what the model last saw (#3222). The system prompt and
	 * earlier history are never edited, so they stay a cached prefix. When a
	 * compaction or a history reset dropped an earlier note, everything is sent
	 * again.
	 */
	private appendContextNote(): void {
		if (this.contextNoteMessages.some((m) => !this.messageHistory.includes(m))) {
			this.contextSent = {};
			this.contextNoteMessages = [];
		}
		const { note, sent } = contextNote(
			{
				memory: this.sessionMemoryContext,
				appendedContext: this.runtimeParams.appendedContext,
				voiceChatActive: getRuntimeParams().voiceChatActive,
			},
			this.contextSent,
		);
		this.contextSent = sent;
		if (!note) return;
		const message = { role: "user", content: note };
		this.messageHistory.push(message);
		this.contextNoteMessages.push(message);
	}

	async chat(userMessage: string, imageBase64?: string, imageMimeType?: string): Promise<string> {
		// Reset circuit breaker, privacy tracker, and honesty ledger for each new turn
		this.loopDetector.reset();
		this.recentFilePaths = [];
		this.turnToolLedger = [];
		// write_file may open each deliverable once per turn (#3107).
		this.executor.beginTurn();

		const textForAgent =
			userMessage.trim() ||
			(imageBase64
				? "The user attached an image with no text. Describe what you see and help with anything relevant in the image."
				: userMessage);

		// If image attached, fire off parallel vision interpretation (like /btw)
		// The main agent stays on its text model — never switches.
		// Vision result gets injected as a harness note when ready (#3260).
		let visionId: string | null = null;

		if (imageBase64) {
			const interpreter = new VisionInterpreter({
				apiKey: this.config.apiKey,
				onResult: (_id, result) => {
					// Inject vision description as a harness note: a second system
					// message would be dropped before the model call (#3260).
					const visionContext = `[Vision Interpretation: ${result.model} (${result.durationMs}ms${result.free ? ", free" : ""})]\n${result.description}`;
					this.messageHistory.push({ role: "user", content: harnessNote(visionContext) });

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
				// A harness note telling the agent to ask this question (#3260)
				this.messageHistory.push({
					role: "user",
					content: harnessNote(
						`[PROACTIVE QUESTIONING] The user's request is vague. Before executing, ask this clarifying question:\n${formatQuestion(question)}\nAsk the user naturally; don't mention this instruction. After they answer, proceed with execution.`,
					),
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
		// A Table officer is answering a colleague in a chat channel, not executing
		// a multi-step build, and its turn prompt is ALWAYS over 100 chars - so
		// this gate fired on every single officer reply and injected the literal
		// text "PLAN: 1. ... 2. ... 3. ..." as the last user message. That is the
		// exact source of the rigid "PLAN: 1. Identify the officer mentioned. 2.
		// ..." scaffolding in the live corpus: not a model tic, an instruction we
		// sent. Nobody at the Table asked for a plan.
		const needsPlanningGate =
			this.config.agentScope !== "__table__" &&
			(textForAgent.length > 100 || PLANNING_KEYWORDS.test(textForAgent));

		// Changed session context goes in before the user's words (#3222).
		this.appendContextNote();

		if (needsPlanningGate) {
			this.messageHistory.push({
				role: "user",
				content: textForAgent,
			});
			// Inject a hard planning constraint the model can't ignore because
			// it's the last user-turn content before generation starts.
			this.messageHistory.push({
				role: "user",
				content: PLANNING_GATE_INSTRUCTION,
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

		// Build provider config — main agent always uses its own model.
		// Thread this session's pinned baseUrl into the AI SDK native path so a
		// per-session endpoint (e.g. an apfel Table officer on :11435/v1) is
		// honoured instead of falling back to the provider DEFAULT_URLS (which
		// only the APFEL_BASE_URL env lever could previously override).
		// toOpenAiV1Base reconciles the base to the "/v1" root createModel wants,
		// so apfel (base already ends /v1) is unchanged and a host-only lmstudio/
		// ollama base gains its "/v1" instead of a truncated URL. Undefined
		// baseUrl (all non-table sessions) leaves resolution exactly as before.
		const providerConfig: ProviderConfig = {
			name: this.config.runtime as ProviderName,
			model: this.config.model,
			apiKey: this.config.apiKey,
			baseURL: this.config.baseUrl ? toOpenAiV1Base(this.config.baseUrl) : undefined,
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
			"locate",
			"update_plan",
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
		// Capability gate (SPEC-05 #108): a provider takes the restricted local-tool
		// path when its tool-calling pathway is the text-tool protocol (or none),
		// resolved from provider capability flags + the EIGHT_TEXT_TOOLS override -
		// never a hardcoded provider-name list. Native tool-callers get all tools.
		const providerName = providerConfig.name as string;
		const providerCaps = getProviderManager().getProvider(providerName as ProviderRegistryName);
		const isLocalProvider = capabilityToolMode(providerCaps) !== "native";
		// Deferred registry only loads `core` upfront — make sure local providers
		// get `web` (and git) before we filter, otherwise CORE_TOOLS entries like
		// web_search won't exist to pass through.
		if (isLocalProvider) {
			this.toolRegistry.loadCategory("web");
			this.toolRegistry.loadCategory("git");
			this.toolRegistry.loadCategory("design");
			this.toolRegistry.loadCategory("self");
			this.toolRegistry.loadCategory("memory");
			// Only the Orchestrator delegates on the local path (#3095).
			if (localDelegationTools(this.config.role).length > 0) {
				this.toolRegistry.loadCategory("orchestration");
			}
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
		// The Orchestrator also gets spawn_agent / check_agent / list_agents;
		// Engineer, QA, sub-agents and role-less agents keep the lean set (#3095).
		const localCoreTools = [
			...CORE_TOOLS,
			...(cuaConfigured ? DESKTOP_TOOLS : []),
			...localDelegationTools(this.config.role),
			// Lean MCP access (#3474): search, schema on demand, trimmed results.
			...(process.env.EIGHT_MCP_LEAN === "1" ? ["mcp_list_tools", "mcp_call_tool"] : []),
		];
		const providerTools = isLocalProvider
			? Object.fromEntries(Object.entries(allTools).filter(([k]) => localCoreTools.includes(k)))
			: allTools;

		// F3 (positive scope, not a blocklist): a __table__ session only needs to
		// COMPOSE a reply - the actual write goes through the gateway's gated
		// post_to_channel path, not a model tool. So it gets an explicit read-only
		// allowlist and never sees run_command / write / edit / git / term_* /
		// desktop_* / network at all. ToolG8's __table__ block rules remain the
		// enforcement backstop; this just stops the model from ever proposing them.
		const TABLE_SESSION_TOOLS = new Set([
			"read_file",
			"list_files",
			"get_outline",
			"get_symbol",
			"search_symbols",
			"recall",
		]);
		const effectiveTools =
			this.config.agentScope === "__table__"
				? Object.fromEntries(
						Object.entries(providerTools).filter(([k]) => TABLE_SESSION_TOOLS.has(k)),
					)
				: providerTools;

		// The SAME positive scope, for the text-tool path. Every Table officer on
		// lmstudio/ollama goes through runTextToolChat, which was handed the raw
		// localCoreTools list - so F3 above was applied only to the native path
		// and bypassed entirely on the one the officers actually use. Measured
		// 2026-08-06: the system prompt an officer received listed write_file,
		// run_command, git_commit and web_search as available, and the loop would
		// have executed them (ToolG8's __table__ rules were the only thing left
		// standing). Officers "hallucinating tool names" were reading a catalog.
		const textToolAllowlist =
			this.config.agentScope === "__table__" ? [...TABLE_SESSION_TOOLS] : localCoreTools;

		// ── Populate runtime params for self-awareness tools ──────────
		Object.assign(this.runtimeParams, {
			// The voice flag is process-wide by design (one terminal, one mic): the
			// TUI sets it on the fallback params, and each agent copies it per turn.
			voiceChatActive: getRuntimeParams().voiceChatActive,
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

		// Apply any previously tuned params (this agent's own, #3140)
		const tunedParams = this.runtimeParams;

		// The system prompt goes out byte-identical every turn (#3222). Appended
		// context and voice mode reach the model as a context message in the
		// history (appendContextNote), so they no longer rewrite it here.
		const effectiveInstructions = systemPrompt || "";

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
		if (shouldUseTextTools(providerName, (this.config.allowedPaths?.length ?? 0) > 0)) {
			const textResult = await this.runTextToolChat({
				providerName,
				providerModel: providerConfig.model,
				instructions: effectiveInstructions,
				localCoreTools: textToolAllowlist,
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
			// Carried into every native tool call; per agent, never process-wide (#3127).
			agentId: this.config.agentScope ?? "primary",
			runtime: this.runtimeParams,
			// Its permission mode, per call, like the context above (#3170).
			permission: this.config.permission,
			// The files it created, one record for both tool paths (#3177).
			createdFiles: this.executor.createdFiles,
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
					workingDirectory: this.config.workingDirectory || process.cwd(),
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
							// The forced-local provider resolves its own endpoint and key:
							// the session's belong to the provider it is leaving (#3261).
							providerConfig.apiKey = undefined;
							providerConfig.baseURL = undefined;
							providerConfig.headers = undefined;
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

				// Honesty ledger (issue #2747): record the REAL outcome. The executor
				// returns error STRINGS for most failures, so a "successful" event
				// whose result is an error marker still counts as a failure.
				this.turnToolLedger.push({
					name: event.toolName,
					args: event.args as Record<string, unknown>,
					success: event.success && !isErrorToolResult(resultStr),
					result: resultStr.slice(0, 500),
				});

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
						content: `[SYSTEM WARNING: LOOP DETECTED] You have tried the same approach (${event.toolName} with similar arguments) ${count} times and it keeps failing. STOP retrying this approach. Instead:\n1. Use web_search to look up the correct API/pattern\n2. Try a COMPLETELY different strategy\n3. If you don't know how a library works, search for its documentation first\nDo NOT repeat the same fix again.`,
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
						workingDirectory: this.config.workingDirectory || process.cwd(),
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
				Object.assign(this.runtimeParams, {
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

				// Build agent for the current provider in the chain. The session's
				// endpoint and key stay with the session's provider; any other
				// provider resolves its own (#3261).
				const stepConfig = {
					...agentConfig,
					provider: providerConfigForStep(providerConfig, currentEntry),
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
							{
								provider: currentEntry.provider,
								model: currentEntry.model,
								local: isLocalProvider,
							},
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
											cand.provider === currentEntry.provider && cand.model === currentEntry.model
												? agent
												: createEightAgent({
														...agentConfig,
														provider: providerConfigForStep(providerConfig, cand),
													});
										// The agent's GenerateTextResult is structurally a superset of the
										// hedge GenerateResult (it has text + steps); widen for the executor.
										return candAgent.generate({
											messages,
											abortSignal: signal,
										}) as unknown as Promise<import("../kernel/hedge-executor").GenerateResult>;
									},
									{
										sessionId: this.sessionId,
										turnIndex: this.messageHistory.filter((m) => m.role === "assistant").length,
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
										provider: providerConfigForStep(providerConfig, hedgeOut.winner),
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

			// ── Law 1 (issue #2747): no fabricated completion ────────────────
			// Gate the final reply on the turn's tool ledger before flavoring.
			const gatedNative = enforceAgenticHonesty({
				content: result.text,
				ledger: this.turnToolLedger,
				workingDirectory: this.config.workingDirectory || process.cwd(),
			});
			if (gatedNative.violated) {
				console.log(`[honesty] blocked fabricated completion: ${gatedNative.reason}`);
			}
			const content = gatedNative.content;

			// Apply personality voice flavoring to the response (never on a reply
			// the honesty gate rewrote - no celebration on a failure).
			const flavor = personalityVoice.getFlavor("complete");
			// Table replies are never flavored - see the same guard on the
			// text-tool path above for why a random COMPLETION_PHRASE in a channel
			// reads as a fabricated completion claim.
			const flavoredContent =
				gatedNative.violated || this.config.agentScope === "__table__"
					? content
					: flavorResponse(content, flavor);

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
			// above. Cheap checkpoint at 65%, hard compact at 80%.
			if (process.env["8GENT_TWO_STAGE_COMPACT"] !== "0") {
				await this.observeTwoStage(providerConfig);
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
					workingDirectory: this.config.workingDirectory || process.cwd(),
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

	/**
	 * The runtime/provider this agent's config is actually bound to right now.
	 * Added alongside getModel() so callers (agent-pool telemetry) can report
	 * the SESSION's real backend instead of the pool's default - see
	 * agent-pool.ts chat()'s usage.recordWithAttribution call.
	 */
	getRuntime(): string {
		return this.config.runtime;
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

	/**
	 * One pass of the two-stage compactor (#2467) after a turn. Thresholds
	 * resolve against the provider's known context window, the same one
	 * ProactiveCompression uses (#3237: this used to read a `contextSize` that
	 * ProviderConfig never carries, so every model was treated as 32,768).
	 */
	private async observeTwoStage(providerConfig: ProviderConfig): Promise<void> {
		try {
			if (!this.twoStageCompactor) {
				const summarizer: Summarizer = async (msgs, { previousSummary }) =>
					this.generateCheckpoint(providerConfig, twoStageCheckpointPrompt(msgs, previousSummary));
				this.twoStageCompactor = new TwoStageCompactor({
					checkpointPct: 0.65,
					compactPct: 0.8,
					keepLastN: 4,
					summarizer,
				});
			}
			const state: TwoStageAgentState = {
				messages: this.messageHistory,
				checkpoints: this.twoStageCheckpoints,
				provider: { contextSize: this.compactionContextWindow },
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

	/** The model call behind a two-stage checkpoint. A method so tests can stand in for it. */
	private async generateCheckpoint(
		providerConfig: ProviderConfig,
		prompt: string,
	): Promise<string> {
		const { generateText } = await import("ai");
		const { text } = await generateText({
			model: createModel(providerConfig),
			prompt,
			maxOutputTokens: 800,
		});
		return text;
	}

	/** Tell the UI a different model serves this turn (#3102). A listener
	 *  that throws must never change which model runs, so it is contained. */
	private emitModelRouted(requested: string, used: string, provider: string): void {
		try {
			this.events.onModelRouted?.({ requested, used, provider });
		} catch {
			// Display only.
		}
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
	 * The result is injected as a harness note before the LLM turn (#3260).
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
				role: "user",
				content: harnessNote(formatPreFetchedContext(decision, result)),
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

/**
 * True when the model runs on this machine: a local provider (the registry's
 * LOCAL_PROVIDERS, plus llama-server) with no base URL, or one on loopback.
 * Decides whether the operator's user-global instructions may be sent (#3236).
 */
export function runsOnBox(runtime: string, baseUrl?: string): boolean {
	if (!isLocalProvider(runtime) && runtime !== "llama-server") return false;
	if (!baseUrl) return true;
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}
