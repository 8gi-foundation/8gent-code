/**
 * 8gent Code - Agent Core
 *
 * The main agent orchestrator. Handles the agentic loop:
 * user message → LLM → tool calls → results → LLM → ... → final response
 */

import * as crypto from "crypto";
import type { Message, ToolCall, AgentConfig, LLMClient } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { createClient, OllamaClient } from "./clients";
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
import type { AgentInfo, Environment } from "../specifications/session/index.js";
import { getLSPManager } from "../lsp";

export class Agent {
  private client: LLMClient;
  private executor: ToolExecutor;
  private messages: Message[] = [];
  private config: AgentConfig;
  private hookManager: HookManager;
  private sessionId: string;
  private sessionStartTime: number;
  private reportingContext: AgentReportingContext | null = null;
  private enableReporting: boolean = true;
  private sessionWriter: SessionWriter;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = createClient(config);
    this.executor = new ToolExecutor(config.workingDirectory || process.cwd());
    this.hookManager = getHookManager();
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionStartTime = Date.now();

    // Set working directory for hooks
    this.hookManager.setWorkingDirectory(config.workingDirectory || process.cwd());

    // Initialize with system prompt
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const languageInstruction = this.getLanguageInstruction();
    this.messages.push({
      role: "system",
      content: basePrompt + languageInstruction,
    });

    // Initialize session persistence
    this.sessionWriter = new SessionWriter(this.sessionId);
    const systemPromptFull = basePrompt + languageInstruction;
    const agentInfo: AgentInfo = {
      model: config.model,
      runtime: config.runtime,
      maxTurns: config.maxTurns,
      systemPromptHash: crypto.createHash("sha256").update(systemPromptFull).digest("hex").slice(0, 16),
    };
    const env: Environment = {
      workingDirectory: config.workingDirectory || process.cwd(),
      platform: process.platform as Environment["platform"],
      nodeVersion: process.version,
    };
    // Write session_start immediately without git info (avoid sync child_process in React effect)
    this.sessionWriter.writeSessionStart({
      sessionId: this.sessionId,
      version: 1,
      startedAt: new Date(this.sessionStartTime).toISOString(),
      agent: agentInfo,
      environment: env,
    });
    // Populate git info asynchronously after constructor returns
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

    // Remove any persisted shell-based voice hooks — they bypass voiceConfig
    const allHooks = this.hookManager.getAllHooks();
    for (const hook of allHooks) {
      if (hook.name === "Voice Completion" && hook.mode === "shell") {
        this.hookManager.unregisterHook(hook.id!);
      }
    }
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    // Log user message to session
    this.sessionWriter.writeUserMessage(userMessage);

    // Initialize reporting context for this task
    if (this.enableReporting) {
      this.reportingContext = createReportingContext(
        userMessage,
        this.config.workingDirectory || process.cwd(),
        this.config.model
      );
    }

    let turns = 0;
    const maxTurns = this.config.maxTurns || 20;
    const chatStartTime = Date.now();

    let totalTokensUsed = 0;

    const tools = this.executor.getToolDefinitions();

    while (turns < maxTurns) {
      const turnIndex = turns;
      turns++;

      this.sessionWriter.writeTurnStart(turnIndex, this.messages.length);

      let response;
      try {
        response = await this.client.chat(this.messages, tools);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.sessionWriter.writeError({
          message: errMsg,
          code: null,
          stack: err instanceof Error ? err.stack ?? null : null,
          recoverable: false,
        });
        this.sessionWriter.writeTurnEnd(turnIndex, "error");
        throw err;
      }

      const content = response.message.content;

      const turnUsage = response.usage?.total_tokens
        ? { totalTokens: response.usage.total_tokens }
        : undefined;
      if (response.usage?.total_tokens) {
        totalTokensUsed += response.usage.total_tokens;
      }

      // Check for tool calls
      const toolCalls = this.parseToolCalls(content);

      if (toolCalls.length > 0) {
        this.sessionWriter.writeAssistantMessage(content, {
          usage: turnUsage,
          turnIndex,
          containsToolCalls: true,
        });

        console.log(`\n[Executing ${toolCalls.length} tool(s)${toolCalls.length > 1 ? ' in parallel' : ''}]`);

        const results = await Promise.all(
          toolCalls.map(async (toolCall) => {
            // Execute beforeTool hooks
            await this.hookManager.executeHooks("beforeTool", {
              sessionId: this.sessionId,
              tool: toolCall.name,
              toolInput: toolCall.arguments,
              workingDirectory: this.config.workingDirectory || process.cwd(),
            });

            console.log(`  -> ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 50)}...)`);
            const toolStartTime = Date.now();
            let result: string;
            let toolError: string | undefined;

            if (this.reportingContext) {
              this.reportingContext.recordToolStart(toolCall.name, toolCall.arguments);
            }

            this.sessionWriter.writeToolCall({
              toolCallId: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
              success: true,
              durationMs: 0,
              startedAt: new Date(toolStartTime).toISOString(),
            }, turnIndex);

            try {
              result = await this.executor.execute(toolCall.name, toolCall.arguments);
            } catch (err) {
              toolError = err instanceof Error ? err.message : String(err);
              result = `Error: ${toolError}`;

              this.sessionWriter.writeError({
                message: `Tool ${toolCall.name} failed: ${toolError}`,
                stack: err instanceof Error ? err.stack ?? null : null,
                recoverable: true,
              });

              await this.hookManager.executeHooks("onError", {
                sessionId: this.sessionId,
                tool: toolCall.name,
                toolInput: toolCall.arguments,
                error: toolError,
                errorStack: err instanceof Error ? err.stack : undefined,
                workingDirectory: this.config.workingDirectory || process.cwd(),
              });
            }

            const toolDuration = Date.now() - toolStartTime;

            this.sessionWriter.writeToolResult(
              toolCall.id,
              !toolError,
              result.slice(0, 2000),
              toolDuration
            );

            // Track file operations for session summary
            if (!toolError) {
              if (toolCall.name === "write_file" && toolCall.arguments.path) {
                this.sessionWriter.trackFileCreated(toolCall.arguments.path as string);
              } else if (toolCall.name === "edit_file" && toolCall.arguments.path) {
                this.sessionWriter.trackFileModified(toolCall.arguments.path as string);
              } else if (toolCall.name === "delete_file" && toolCall.arguments.path) {
                this.sessionWriter.trackFileDeleted(toolCall.arguments.path as string);
              }
            }

            if (this.reportingContext) {
              this.reportingContext.recordToolEnd(
                toolCall.name,
                toolCall.arguments,
                result,
                toolStartTime,
                !toolError
              );

              if (toolCall.name === "git_commit" && result.includes("[")) {
                const commitHash = extractCommitHash(result);
                if (commitHash) {
                  this.reportingContext.addGitCommit(commitHash);
                  this.sessionWriter.trackGitCommit(commitHash);
                }
              }
              if (toolCall.name === "git_status" || toolCall.name === "git_branch") {
                const branch = extractBranchName(result);
                if (branch) {
                  this.reportingContext.setGitBranch(branch);
                }
              }
            }

            await this.hookManager.executeHooks("afterTool", {
              sessionId: this.sessionId,
              tool: toolCall.name,
              toolInput: toolCall.arguments,
              toolOutput: result,
              duration: toolDuration,
              error: toolError,
              workingDirectory: this.config.workingDirectory || process.cwd(),
            });

            return { name: toolCall.name, result };
          })
        );

        this.sessionWriter.writeTurnEnd(turnIndex, "tool_calls", turnUsage);

        this.messages.push({ role: "assistant", content });

        const aggregatedResults = results
          .map((r, i) => `[Tool ${i + 1} Result for ${r.name}]:\n${r.result}`)
          .join("\n\n");

        this.messages.push({
          role: "user",
          content: `${aggregatedResults}\n\nNow respond to the user based on these results. Do NOT call the same tools again.`,
        });

        continue;
      } else {
        // No tool call, return the response
        this.messages.push({ role: "assistant", content });

        this.sessionWriter.writeAssistantMessage(content, {
          usage: turnUsage,
          turnIndex,
          containsToolCalls: false,
        });

        this.sessionWriter.writeTurnEnd(turnIndex, "natural_stop", turnUsage);

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
      }
    }

    // Max turns reached
    this.sessionWriter.writeTurnEnd(turns - 1, "max_turns");
    this.sessionWriter.writeError({
      message: "Max turns reached",
      recoverable: false,
    });

    if (this.reportingContext && this.enableReporting) {
      this.reportingContext.setError("Max turns reached");
      this.reportingContext.complete({ display: true, save: true });
    }

    await this.hookManager.executeHooks("onComplete", {
      sessionId: this.sessionId,
      result: "Max turns reached",
      duration: Date.now() - chatStartTime,
      workingDirectory: this.config.workingDirectory || process.cwd(),
    });

    return "Max turns reached. Please try a simpler request.";
  }

  /**
   * Parse multiple tool calls from LLM content.
   * Supports both single tool and multiple parallel tools.
   */
  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Strategy 1: Multiple JSON objects (parallel format)
    const jsonLinePattern = /\{"tool"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
    let match;

    while ((match = jsonLinePattern.exec(content)) !== null) {
      try {
        const args = JSON.parse(match[2]);
        toolCalls.push({
          id: `${Date.now()}-${toolCalls.length}`,
          name: match[1],
          arguments: args,
        });
      } catch {
        // Skip malformed JSON
      }
    }

    if (toolCalls.length > 0) {
      return toolCalls;
    }

    // Strategy 2: Code fence with JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.tool) {
              toolCalls.push({
                id: `${Date.now()}-${toolCalls.length}`,
                name: item.tool,
                arguments: item.arguments || {},
              });
            }
          }
          return toolCalls;
        }
        if (parsed.tool) {
          return [{
            id: Date.now().toString(),
            name: parsed.tool,
            arguments: parsed.arguments || {},
          }];
        }
      } catch {
        const lines = jsonMatch[1].split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.tool) {
              toolCalls.push({
                id: `${Date.now()}-${toolCalls.length}`,
                name: parsed.tool,
                arguments: parsed.arguments || {},
              });
            }
          } catch {
            // Skip non-JSON lines
          }
        }
        if (toolCalls.length > 0) {
          return toolCalls;
        }
      }
    }

    // Strategy 3: Extract tool name and arguments for write_file with complex content
    const toolMatch = content.match(/"tool"\s*:\s*"(\w+)"/);
    if (toolMatch && toolMatch[1]) {
      const toolName = toolMatch[1];
      let args: Record<string, unknown> = {};

      if (toolName === "write_file") {
        const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
        const contentMatch = content.match(/"content"\s*:\s*[`"]([\s\S]*?)[`"]\s*\}/);
        if (pathMatch) {
          args = {
            path: pathMatch[1],
            content: contentMatch ? contentMatch[1] : "",
          };
        }
      } else {
        const argsMatch = content.match(/"arguments"\s*:\s*\{([^]*?)\}\s*\}/);
        if (argsMatch) {
          try {
            args = JSON.parse(`{${argsMatch[1]}}`);
          } catch {
            const commandMatch = content.match(/"command"\s*:\s*"([^"]+)"/);
            if (commandMatch) args = { command: commandMatch[1] };

            const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
            if (pathMatch) args = { ...args, path: pathMatch[1] };

            const filePathMatch = content.match(/"filePath"\s*:\s*"([^"]+)"/);
            if (filePathMatch) args = { ...args, filePath: filePathMatch[1] };

            const lineMatch = content.match(/"line"\s*:\s*(\d+)/);
            if (lineMatch) args = { ...args, line: parseInt(lineMatch[1], 10) };

            const charMatch = content.match(/"character"\s*:\s*(\d+)/);
            if (charMatch) args = { ...args, character: parseInt(charMatch[1], 10) };
          }
        }
      }

      return [{
        id: Date.now().toString(),
        name: toolName,
        arguments: args,
      }];
    }

    return [];
  }

  async isReady(): Promise<boolean> {
    return this.client.isAvailable();
  }

  clearHistory(): void {
    this.messages = [this.messages[0]]; // Keep system prompt
  }

  getModel(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
    this.client = new OllamaClient(model);
  }

  getHistoryLength(): number {
    return this.messages.length;
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

  /**
   * Cleanup LSP clients and finalize session on shutdown
   */
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
