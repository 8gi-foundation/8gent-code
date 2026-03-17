/**
 * 8gent Code - Agent Core
 *
 * The main agent orchestrator. Powered by the Vercel AI SDK via packages/ai.
 * Uses ToolLoopAgent for the agentic loop instead of a manual while loop.
 *
 * v2: Emits step_start/step_end/assistant_content session entries with
 * full AI SDK data (finishReason, reasoning, detailed token usage, etc.)
 */

import * as crypto from "crypto";
import type { AgentConfig, AgentEventCallbacks } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { createClient } from "./clients";
import { ToolExecutor } from "./tools";
import { VisionInterpreter } from "./vision-interpreter";
import { getHookManager, type HookManager } from "../hooks";
import { extractCommitHash, extractBranchName } from "../reporting";
import { appendRun, type RunLogEntry } from "../reporting/runlog";
import { SessionWriter } from "../specifications/session/writer.js";
import type { AgentInfo, Environment, ContentPart, DetailedTokenUsage } from "../specifications/session/index.js";
import { getLSPManager } from "../lsp";
import { getProactivePlanner, type ProactivePlanner } from "../planning/proactive-planner";
import { EvidenceCollector, type Evidence, summarizeEvidence } from "../validation/evidence";
import { indexFolder as astIndexFolder } from "../ast-index";
import { getHeartbeatAgents, type HeartbeatAgents } from "../self-autonomy/heartbeat";
import { OnboardingManager } from "../self-autonomy/onboarding";
import { startTelegramBot, getActiveTelegramBot } from "../telegram";
import { getVault } from "../secrets";
import { createInfiniteRunner, type InfiniteRunner, type InfiniteState } from "../infinite";
import { getMemoryManager, extractAutoMemories } from "../memory";

// Proactive questioning — asks clarifying questions before executing vague tasks
import { needsClarification, createGatherer, formatQuestion, type ProactiveGatherer } from "../proactive";

// Personality voice — the infinite gentleman
import {
  PERSONALITY,
  voice as personalityVoice,
  getCompletionPhrase,
  getErrorPhrase,
  getGreeting,
  flavorResponse,
} from "../personality/voice.js";
import { BRAND } from "../personality/brand.js";

// Workflow validation — BMAD plan-validate loop + Kanban tracking
import {
  PlanValidateLoop,
  parsePlanFromResponse,
  formatPlan,
  getKanbanBoard,
  classifyTaskSize,
  generateAcceptanceCriteria,
  decomposeTask,
  PROACTIVE_SYSTEM_ADDITION,
  type Step,
  type BMadTask,
} from "../workflow";

// AI SDK imports
import {
  createEightAgent,
  setToolContext,
  type EightAgentConfig,
  type ProviderConfig,
  type ProviderName,
  type StepFinishEvent,
} from "../ai";

export class Agent {
  private executor: ToolExecutor;
  private config: AgentConfig;
  private hookManager: HookManager;
  private sessionId: string;
  private sessionStartTime: number;
  private enableReporting: boolean = true;
  private totalCost: number | null = null;
  private sessionWriter: SessionWriter;
  private messageHistory: Array<{ role: string; content: string }> = [];
  private toolCallTracker: Map<string, number> = new Map(); // fingerprint -> count
  private loopWarningInjected = false;
  private events: AgentEventCallbacks;
  private planner: ProactivePlanner;
  private evidenceCollector: EvidenceCollector;
  private sessionEvidence: Evidence[] = [];
  private proactiveGatherer: ProactiveGatherer | null = null;
  private workflowValidator: PlanValidateLoop;
  private kanban = getKanbanBoard();
  private currentBmadTask: BMadTask | null = null;
  private heartbeat: HeartbeatAgents;
  private onboarding: OnboardingManager;
  private infiniteRunner: InfiniteRunner | null = null;
  private infiniteModeActive: boolean = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.events = config.events || {};
    this.executor = new ToolExecutor(config.workingDirectory || process.cwd());
    this.hookManager = getHookManager();
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionStartTime = Date.now();

    // Set working directory for hooks
    this.hookManager.setWorkingDirectory(config.workingDirectory || process.cwd());

    // Set tool context for AI SDK tools
    setToolContext({ workingDirectory: config.workingDirectory || process.cwd() });

    // Fire-and-forget AST indexing of working directory for AST-first retrieval
    const cwd = config.workingDirectory || process.cwd();
    astIndexFolder(cwd).then((index) => {
      console.log(`[AST] Indexed ${index.fileCount} files, ${index.symbolCount} symbols`);
    }).catch(() => {
      // AST indexing is best-effort, don't block agent startup
    });

    // Initialize proactive planner and evidence collector
    this.planner = getProactivePlanner();
    this.evidenceCollector = new EvidenceCollector({
      workingDirectory: config.workingDirectory || process.cwd(),
    });

    // Initialize workflow validator (BMAD plan-validate loop)
    this.workflowValidator = new PlanValidateLoop({
      workingDirectory: config.workingDirectory || process.cwd(),
      maxRetries: 2,
      validateEachStep: true,
      collectEvidence: true,
      abortOnFailure: false,
    });

    // Build system prompt with personality voice injected
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const languageInstruction = this.getLanguageInstruction();

    // Inject the 8gent personality voice into the system prompt
    const personalityBlock = `\n\n## PERSONALITY VOICE — ${BRAND.fullName}: ${PERSONALITY.tagline}
You are ${PERSONALITY.name}, the infinite gentleman agent coder.
Traits: refined, witty, confident, helpful, endlessly capable.
When greeting users, use phrases like: "${getGreeting()}"
When completing tasks, use phrases like: "${getCompletionPhrase()}"
When encountering errors, stay composed: "${getErrorPhrase()}"
Maintain a tone that is sophisticated yet approachable — like a well-dressed engineer who happens to be brilliant.\n`;

    this.messageHistory.push({
      role: "system",
      content: basePrompt + personalityBlock + languageInstruction,
    });

    // Initialize session persistence (v2)
    this.sessionWriter = new SessionWriter(this.sessionId);
    const systemPromptFull = basePrompt + personalityBlock + languageInstruction;
    const agentInfo: AgentInfo = {
      model: config.model,
      runtime: config.runtime,
      maxTurns: config.maxTurns,
      maxSteps: config.maxTurns || 30,
      systemPromptHash: crypto.createHash("sha256").update(systemPromptFull).digest("hex").slice(0, 16),
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

    // Fire-and-forget: Track session in Convex (if authenticated)
    this._trackSessionStart(config.model, config.runtime);

    // Populate git info asynchronously
    import("child_process").then(({ exec }) => {
      exec("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 2000 }, (err, stdout) => {
        if (!err && stdout) env.gitBranch = stdout.trim();
      });
    }).catch(() => {});

    // Execute onStart hooks
    this.hookManager.executeHooks("onStart", {
      sessionId: this.sessionId,
      workingDirectory: config.workingDirectory || process.cwd(),
    });

    // Remove any persisted shell-based voice hooks
    const allHooks = this.hookManager.getAllHooks();
    for (const hook of allHooks) {
      if (hook.name === "Voice Completion" && hook.mode === "shell") {
        this.hookManager.unregisterHook(hook.id!);
      }
    }

    // ── Self-Autonomy: Heartbeat ─────────────────────────────────────
    // Start background heartbeat agents (git monitoring, self-heal, memory sync)
    this.heartbeat = getHeartbeatAgents({
      workingDirectory: config.workingDirectory || process.cwd(),
      verbose: false,
    });
    this.heartbeat.start();
    this.heartbeat.updateContext({ currentTask: "Agent initialized" });

    // ── Self-Autonomy: Onboarding ────────────────────────────────────
    // Check if first run — if .8gent/user.json doesn't exist, flag for onboarding
    this.onboarding = new OnboardingManager(config.workingDirectory || process.cwd());
    if (this.onboarding.needsOnboarding()) {
      // Detect integrations (Ollama, LM Studio, GitHub) in background
      this.onboarding.detectIntegrations().catch(() => {});
      console.log("[8gent] First run detected — onboarding available. The agent can ask setup questions.");
    }

    // ── Telegram: Auto-start if token exists in vault ────────────────
    const vault = getVault();
    if (vault.has("TELEGRAM_BOT_TOKEN") && !getActiveTelegramBot()) {
      const telegramToken = vault.get("TELEGRAM_BOT_TOKEN");
      if (telegramToken) {
        const chatId = vault.get("TELEGRAM_CHAT_ID");
        startTelegramBot(telegramToken, this, {
          allowedUsers: chatId ? [parseInt(chatId, 10)] : undefined,
        }).catch((err) => {
          console.log(`[8gent] Telegram auto-start failed: ${err.message}`);
        });
      }
    }
  }

  async chat(userMessage: string, imageBase64?: string, imageMimeType?: string): Promise<string> {
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
            text: `🔍 Image interpreted by ${result.model}${result.free ? " (free)" : ""} in ${(result.durationMs / 1000).toFixed(1)}s:\n${result.description.slice(0, 200)}${result.description.length > 200 ? "..." : ""}`,
            stepNumber: 0,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: "other",
          } as any);
        },
      });

      // Fire and forget — runs in parallel while main agent works
      visionId = interpreter.interpret(imageBase64, imageMimeType || "image/png");

      this.config.events?.onStepFinish?.({
        text: `📷 Image attached — vision interpreter running in background...`,
        stepNumber: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "other",
      } as any);
    }

    // ── Proactive Questioning Gate ─────────────────────────────────
    // For vague/ambiguous requests (short messages without clear intent),
    // the proactive system injects clarifying questions before execution.
    if (needsClarification(userMessage)) {
      this.proactiveGatherer = createGatherer(userMessage);
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
    const taskSize = classifyTaskSize(userMessage);
    if (taskSize !== "trivial") {
      this.currentBmadTask = this.kanban.createTask(
        userMessage.slice(0, 80),
        userMessage,
        { size: taskSize }
      );
      this.kanban.moveTask(this.currentBmadTask.id, "ready");
      this.kanban.moveTask(this.currentBmadTask.id, "in_progress");
    }

    // ── Planning Gate ──────────────────────────────────────────────
    // Local models skip the BMAD planning in the system prompt and jump
    // straight to tool calls. For multi-step tasks we inject an explicit
    // instruction that forces the model to emit a numbered plan first.
    const PLANNING_KEYWORDS = /\b(build|create|implement|fix|refactor|add|setup|configure|migrate|convert|redesign|scaffold|deploy|integrate)\b/i;
    const needsPlanningGate =
      userMessage.length > 100 || PLANNING_KEYWORDS.test(userMessage);

    if (needsPlanningGate) {
      this.messageHistory.push({
        role: "user",
        content: userMessage,
      });
      // Inject a hard planning constraint the model can't ignore because
      // it's the last user-turn content before generation starts.
      this.messageHistory.push({
        role: "user",
        content:
          `[PLANNING REQUIRED] Before executing ANY tools, you MUST output your plan as:\nPLAN:\n1. [step]\n2. [step]\n3. [step]\nThen execute each step. Do NOT call tools until you have output the plan.`,
      });
    } else {
      // Simple / short messages go through without a planning gate
      this.messageHistory.push({ role: "user", content: userMessage });
    }

    // Log user message to session
    this.sessionWriter.writeUserMessage(userMessage);

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
    const systemPrompt = this.messageHistory.find(m => m.role === "system")?.content;

    // Create the AI SDK agent with v2 session callbacks
    const agentConfig: EightAgentConfig = {
      provider: providerConfig,
      instructions: systemPrompt,
      maxSteps: this.config.maxTurns || 30,
      workingDirectory: this.config.workingDirectory || process.cwd(),

      onToolCallStart: async (event) => {
        await this.hookManager.executeHooks("beforeTool", {
          sessionId: this.sessionId,
          tool: event.toolName,
          toolInput: event.args,
          workingDirectory: this.config.workingDirectory || process.cwd(),
        });

        console.log(`  -> ${event.toolName}(${JSON.stringify(event.args).slice(0, 50)}...)`);

        this.events.onToolStart?.({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          stepNumber: event.stepNumber,
        });

        this.sessionWriter.writeToolCall({
          toolCallId: event.toolCallId,
          name: event.toolName,
          arguments: event.args,
          success: true,
          durationMs: 0,
          startedAt: new Date().toISOString(),
        }, undefined, event.stepNumber);
      },

      onToolCallFinish: async (event) => {
        const resultStr = typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);

        // Loop detection: track repeated tool calls with similar args
        const fingerprint = `${event.toolName}:${JSON.stringify(event.args).slice(0, 200)}`;
        const count = (this.toolCallTracker.get(fingerprint) || 0) + 1;
        this.toolCallTracker.set(fingerprint, count);

        if (count >= 3 && !event.success && !this.loopWarningInjected) {
          this.loopWarningInjected = true;
          console.log(`\n⚠️  [LOOP DETECTED] Tool "${event.toolName}" has been called ${count} times with similar args and keeps failing.`);
          console.log(`   Injecting guidance to try a different approach.\n`);
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

        if (event.success) {
          this.sessionWriter.writeToolResult(
            event.toolCallId,
            true,
            resultStr.slice(0, 2000),
            event.durationMs,
            event.toolName,
            event.stepNumber
          );
        } else {
          // v2: emit distinct tool_error entry
          const errorStr = typeof event.error === "string"
            ? event.error
            : event.error instanceof Error
              ? event.error.message
              : JSON.stringify(event.error);
          this.sessionWriter.writeToolError(
            event.toolCallId,
            event.toolName,
            errorStr,
            event.stepNumber
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
          ...((!event.success && typeof event.error === "string")
            ? { lastError: event.error }
            : {}),
        });

        // Fire-and-forget evidence collection for significant operations
        if (event.success && ["write_file", "edit_file", "run_command", "git_commit"].includes(event.toolName)) {
          this.collectToolEvidence(event).then(ev => {
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
          }).catch(() => {}); // evidence is supplementary, never block
        }

        // Auto-memory: extract project facts from tool results
        if (event.success && ["read_file", "run_command"].includes(event.toolName)) {
          try {
            const autoFacts = extractAutoMemories(event.toolName, event.args, resultStr);
            if (autoFacts.length > 0) {
              const memory = getMemoryManager(this.config.workingDirectory || process.cwd());
              for (const { fact, layer } of autoFacts) {
                memory.remember(fact, layer, { source: `auto:${event.toolName}` });
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
      },

      onStepFinish: async (event: StepFinishEvent) => {
        stepCount++;

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
        if (event.text && event.text.includes("🎯 COMPLETED") && event.finishReason === "stop") {
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
            console.log(`\n[Step ${event.stepNumber}] Parsed ${injectedSteps.length} plan steps → kanban ready queue`);
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
                const bmadStep = this.currentBmadTask.steps.find(
                  s => s.status === "pending"
                );
                if (bmadStep) {
                  bmadStep.action = vs.action;
                  this.kanban.updateStep(
                    this.currentBmadTask.id,
                    bmadStep.id,
                    "in_progress"
                  );
                }
              }
              console.log(`[Workflow] ${validationSteps.length} steps registered for validation | ${formatPlan(validationSteps)}`);
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
        this.sessionWriter.writeStepEnd(
          event.stepNumber,
          event.finishReason as any,
          {
            usage: detailedUsage,
            response: event.response,
            providerMetadata: event.providerMetadata,
          }
        );

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

          this.sessionWriter.writeAssistantContent(
            event.stepNumber,
            parts,
            detailedUsage
          );
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
      const agent = createEightAgent(agentConfig);

      // Build messages array from conversation history (excluding system prompt,
      // which is already passed as `instructions` to the ToolLoopAgent)
      const messages = this.messageHistory
        .filter(m => m.role !== "system")
        .map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const result = await agent.generate({ messages });

      const content = result.text;

      // Apply personality voice flavoring to the response
      const flavor = personalityVoice.getFlavor("complete");
      const flavoredContent = flavorResponse(content, flavor);

      this.messageHistory.push({ role: "assistant", content: flavoredContent });

      // Move BMAD task to review/done if we had one
      if (this.currentBmadTask) {
        this.kanban.moveTask(this.currentBmadTask.id, "review");
        // If evidence looks good, move to done
        if (this.sessionEvidence.length > 0) {
          const verifiedCount = this.sessionEvidence.filter(e => e.verified).length;
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
          prompt: userMessage.slice(0, 120),
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
          console.log(`[8gent:heal] Attempting recovery for ${severity} error: ${errMsg.slice(0, 80)}`);
          try {
            const recovery = await autonomy.handleError(
              err,
              "agent-chat",
              () => this.chat(userMessage, imageBase64, imageMimeType),
              2 // max 2 retries in infinite mode
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
        stack: err instanceof Error ? err.stack ?? null : null,
        recoverable: false,
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
          prompt: userMessage.slice(0, 120),
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

  private async collectToolEvidence(event: { toolName: string; args: Record<string, unknown>; result: any }): Promise<Evidence[]> {
    if ((event.toolName === "write_file" || event.toolName === "edit_file") && event.args.path) {
      return this.evidenceCollector.collectForFileWrite(String(event.args.path));
    }
    if (event.toolName === "git_commit") {
      return this.evidenceCollector.collectForGitCommit();
    }
    if (event.toolName === "run_command" && event.args.command) {
      return this.evidenceCollector.collectForCommand(
        String(event.args.command),
        typeof event.result === "string" ? event.result : JSON.stringify(event.result)
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
  enableInfiniteMode(task: string, config?: { maxIterations?: number; maxTimeMs?: number }): InfiniteRunner {
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

  // ── Convex Session Tracking ──────────────────────────────────────
  private _convexSessionId: string | null = null;

  private async _trackSessionStart(model: string, runtime: string): Promise<void> {
    try {
      const { getConvexClient } = await import("../../packages/db/client.js");
      const client = getConvexClient();
      // @ts-ignore — dynamic import of Convex API
      const { api } = await import("../../packages/db/convex/_generated/api.js");
      const result = await client.mutation(api.sessions.start, {
        model: model || "unknown",
        provider: runtime || "ollama",
      });
      if (result) this._convexSessionId = result;
    } catch {
      // DB not available — silent, never blocks agent
    }
  }

  private async _trackSessionEnd(): Promise<void> {
    if (!this._convexSessionId) return;
    try {
      const { getConvexClient } = await import("../../packages/db/client.js");
      const client = getConvexClient();
      const { api } = await import("../../packages/db/convex/_generated/api.js");
      await client.mutation(api.sessions.end, {
        sessionId: this._convexSessionId,
        tokensUsed: this.totalTokensUsed || 0,
        toolCalls: this.turnNumber || 0,
      });
    } catch {
      // Silent — never blocks cleanup
    }
  }

  async cleanup(): Promise<void> {
    // Track session end in Convex
    await this._trackSessionEnd().catch(() => {});
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
