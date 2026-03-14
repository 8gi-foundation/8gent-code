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
import { getHookManager, type HookManager } from "../hooks";
import { extractCommitHash, extractBranchName } from "../reporting";
import { appendRun, type RunLogEntry } from "../reporting/runlog";
import { SessionWriter } from "../specifications/session/writer.js";
import type { AgentInfo, Environment, ContentPart, DetailedTokenUsage } from "../specifications/session/index.js";
import { getLSPManager } from "../lsp";

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

    // Build system prompt
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const languageInstruction = this.getLanguageInstruction();
    this.messageHistory.push({
      role: "system",
      content: basePrompt + languageInstruction,
    });

    // Initialize session persistence (v2)
    this.sessionWriter = new SessionWriter(this.sessionId);
    const systemPromptFull = basePrompt + languageInstruction;
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

    // Populate git info asynchronously
    const cwd = config.workingDirectory || process.cwd();
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
  }

  async chat(userMessage: string): Promise<string> {
    this.messageHistory.push({ role: "user", content: userMessage });

    // Log user message to session
    this.sessionWriter.writeUserMessage(userMessage);

    // Reset cost tracking for this run
    this.totalCost = null;

    const chatStartTime = Date.now();
    let totalTokensUsed = 0;
    let stepCount = 0;

    // Build provider config from AgentConfig
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
        // All logging handled per-step above
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
      this.messageHistory.push({ role: "assistant", content });

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
      const finalContent = content;

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

      return content;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

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

  private getLanguageInstruction(): string {
    try {
      const { getLanguageManager } = require("../i18n/index.js");
      return getLanguageManager().getLanguageInstruction();
    } catch {
      return "";
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.sessionWriter.writeSessionEnd("user_exit", null);
    } catch {
      // Session writer may already be closed
    }

    const manager = getLSPManager();
    await manager.stopAll();
  }
}
