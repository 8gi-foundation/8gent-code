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
import type { AgentConfig } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { createClient } from "./clients";
import { ToolExecutor } from "./tools";
import { getHookManager, type HookManager } from "../hooks";
import {
  AgentReportingContext,
  createReportingContext,
  extractCommitHash,
  extractBranchName,
  generateCompletionMarker,
  getCompletionReporter,
} from "../reporting";
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
  private reportingContext: AgentReportingContext | null = null;
  private enableReporting: boolean = true;
  private sessionWriter: SessionWriter;
  private messageHistory: Array<{ role: string; content: string }> = [];

  constructor(config: AgentConfig) {
    this.config = config;
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

    // Initialize reporting context
    if (this.enableReporting) {
      this.reportingContext = createReportingContext(
        userMessage,
        this.config.workingDirectory || process.cwd(),
        this.config.model
      );
    }

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

        if (this.reportingContext) {
          this.reportingContext.recordToolStart(event.toolName, event.args);
        }

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

        if (this.reportingContext) {
          this.reportingContext.recordToolEnd(
            event.toolName,
            event.args,
            resultStr,
            Date.now(),
            event.success
          );

          if (event.toolName === "git_commit" && resultStr.includes("[")) {
            const commitHash = extractCommitHash(resultStr);
            if (commitHash) {
              this.reportingContext.addGitCommit(commitHash);
              this.sessionWriter.trackGitCommit(commitHash);
            }
          }
          if (event.toolName === "git_status" || event.toolName === "git_branch") {
            const branch = extractBranchName(resultStr);
            if (branch) {
              this.reportingContext.setGitBranch(branch);
            }
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

      // Generate completion report
      let finalContent = content;
      if (this.reportingContext && this.enableReporting) {
        if (totalTokensUsed > 0) {
          this.reportingContext.setTokensUsed(totalTokensUsed);
        }
        this.reportingContext.setResult(content);
        const report = this.reportingContext.complete({ display: true, save: true });
        const completionMarker = generateCompletionMarker(report);
        finalContent = content + completionMarker;
      }

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

      if (this.reportingContext && this.enableReporting) {
        this.reportingContext.setError(errMsg);
        this.reportingContext.complete({ display: true, save: true });
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

  getLastReport() {
    if (this.reportingContext) {
      const reporter = getCompletionReporter();
      const context = this.reportingContext.getContext();
      return reporter.generateReport(context);
    }
    return null;
  }

  async cleanup(): Promise<void> {
    try {
      const lastReport = this.getLastReport();
      this.sessionWriter.writeSessionEnd("user_exit", lastReport?.id ?? null);
    } catch {
      // Session writer may already be closed
    }

    const manager = getLSPManager();
    await manager.stopAll();
  }
}
