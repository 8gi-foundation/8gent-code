/**
 * Self-Summarization Engine
 *
 * Compresses conversation history to ~1k tokens while preserving
 * critical context: file paths, decisions, errors, and tool results.
 *
 * Inspired by Cursor Composer 2's trained self-summarization technique.
 * Their approach uses RL to train the model on what to keep vs discard.
 * Ours starts with prompted summarization via Ollama, with compression
 * quality tracking so we can later feed (summary, outcome) pairs into
 * GRPO training to close the gap.
 *
 * @see quarantine/self-summarization.md for full design rationale
 */

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Optional tool call metadata */
  toolName?: string;
  /** Timestamp for recency weighting */
  timestamp?: number;
}

export interface SummaryResult {
  /** The compressed summary message to replace original history */
  summary: Message;
  /** Original token count (estimated) */
  originalTokens: number;
  /** Summary token count (estimated) */
  summaryTokens: number;
  /** Compression ratio (original / summary) */
  compressionRatio: number;
  /** Quality metrics for GRPO training pairs */
  quality: CompressionQuality;
}

export interface CompressionQuality {
  /** File paths mentioned in original that appear in summary */
  filePathsKept: string[];
  /** File paths mentioned in original but missing from summary */
  filePathsLost: string[];
  /** Errors mentioned in original that appear in summary */
  errorsKept: string[];
  /** Errors mentioned in original but missing from summary */
  errorsLost: string[];
  /** Decision keywords preserved (e.g. "chose", "decided", "because") */
  decisionsKept: number;
  /** Retention score: 0-1, higher is better */
  retentionScore: number;
}

export interface SelfSummarizerConfig {
  /** Ollama model to use for summarization (default: qwen3.5) */
  model: string;
  /** Ollama base URL (default: http://localhost:11434) */
  ollamaUrl: string;
  /** Target summary token count (default: 1000) */
  targetTokens: number;
  /** Token threshold to trigger summarization (default: 80% of context window) */
  triggerThreshold: number;
  /** Context window size of the active model (default: 32768) */
  contextWindow: number;
  /** Directory to persist quality metrics */
  dataDir: string;
}

const DEFAULT_CONFIG: SelfSummarizerConfig = {
  model: "qwen3.5",
  ollamaUrl: "http://localhost:11434",
  targetTokens: 1000,
  triggerThreshold: 0.8,
  contextWindow: 32768,
  dataDir: ".8gent/kernel/summarizer",
};

// ── Core ───────────────────────────────────────────────────────────

export class SelfSummarizer {
  private config: SelfSummarizerConfig;

  constructor(config: Partial<SelfSummarizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Estimate token count - rough 4 chars per token heuristic */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Check if conversation needs summarization */
  shouldSummarize(messages: Message[]): boolean {
    const totalText = messages.map((m) => m.content).join("\n");
    const tokens = this.estimateTokens(totalText);
    return tokens > this.config.contextWindow * this.config.triggerThreshold;
  }

  /** Compress conversation history, preserving critical context */
  async summarize(messages: Message[]): Promise<SummaryResult> {
    const originalText = messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    const originalTokens = this.estimateTokens(originalText);

    // Extract critical artifacts before summarization for quality tracking
    const originalPaths = this.extractFilePaths(originalText);
    const originalErrors = this.extractErrors(originalText);

    const prompt = this.buildSummarizationPrompt(messages);
    const summaryText = await this.callOllama(prompt);

    const summaryTokens = this.estimateTokens(summaryText);

    // Track what survived compression
    const summaryPaths = this.extractFilePaths(summaryText);
    const summaryErrors = this.extractErrors(summaryText);
    const decisionsKept = this.countDecisionMarkers(summaryText);

    const filePathsKept = originalPaths.filter((p) => summaryPaths.includes(p));
    const filePathsLost = originalPaths.filter((p) => !summaryPaths.includes(p));
    const errorsKept = originalErrors.filter((e) => summaryText.includes(e.slice(0, 40)));
    const errorsLost = originalErrors.filter((e) => !summaryText.includes(e.slice(0, 40)));

    // Retention score: weighted average of what was preserved
    const pathScore =
      originalPaths.length > 0 ? filePathsKept.length / originalPaths.length : 1;
    const errorScore =
      originalErrors.length > 0 ? errorsKept.length / originalErrors.length : 1;
    const retentionScore = pathScore * 0.5 + errorScore * 0.3 + Math.min(decisionsKept / 5, 1) * 0.2;

    const quality: CompressionQuality = {
      filePathsKept,
      filePathsLost,
      errorsKept,
      errorsLost,
      decisionsKept,
      retentionScore,
    };

    const result: SummaryResult = {
      summary: {
        role: "system",
        content: `[Context Summary - compressed from ${originalTokens} tokens]\n\n${summaryText}`,
        timestamp: Date.now(),
      },
      originalTokens,
      summaryTokens,
      compressionRatio: originalTokens / Math.max(summaryTokens, 1),
      quality,
    };

    // Persist for GRPO training pair collection
    this.persistQualityMetrics(result);

    return result;
  }

  // ── Prompt Construction ────────────────────────────────────────

  private buildSummarizationPrompt(messages: Message[]): string {
    const conversation = messages
      .map((m) => `[${m.role}${m.toolName ? ` (${m.toolName})` : ""}]: ${m.content}`)
      .join("\n\n");

    return `You are a context compression engine. Summarize this conversation into ~${this.config.targetTokens} tokens.

MANDATORY - preserve ALL of these if they appear:
1. File paths that were read, edited, or created (exact paths)
2. Errors and stack traces encountered (key error messages)
3. Decisions made and their reasoning ("chose X because Y")
4. Tool results that changed system state (file edits, git operations, installs)
5. Current task status and next steps

DISCARD:
- Pleasantries and filler
- Redundant re-explanations
- Code that was shown but not modified
- Exploratory reads that led nowhere

Format the summary as structured notes, not prose. Use sections:
## Files Touched
## Decisions
## Errors Encountered
## Current State
## Next Steps

CONVERSATION:
${conversation}

COMPRESSED SUMMARY:`;
  }

  // ── Ollama Integration ─────────────────────────────────────────

  private async callOllama(prompt: string): Promise<string> {
    const response = await fetch(`${this.config.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3, // Low temp for faithful summarization
          num_predict: this.config.targetTokens * 5, // Chars, not tokens
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama summarization failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }

  // ── Extraction Helpers ─────────────────────────────────────────

  private extractFilePaths(text: string): string[] {
    // Match Unix-style paths and common project paths
    const pathRegex = /(?:\/[\w./-]+|(?:src|packages|apps|lib|config|docs)\/[\w./-]+)/g;
    const matches = text.match(pathRegex) || [];
    return [...new Set(matches)];
  }

  private extractErrors(text: string): string[] {
    const errorPatterns = [
      /(?:Error|TypeError|ReferenceError|SyntaxError|ENOENT|EISDIR|EPERM)[:\s][^\n]+/g,
      /(?:failed|FAILED|Failed)[:\s][^\n]+/g,
    ];
    const errors: string[] = [];
    for (const pattern of errorPatterns) {
      const matches = text.match(pattern) || [];
      errors.push(...matches);
    }
    return [...new Set(errors)];
  }

  private countDecisionMarkers(text: string): number {
    const markers = ["chose", "decided", "because", "instead of", "rather than", "trade-off", "picked"];
    return markers.reduce((count, marker) => {
      const regex = new RegExp(marker, "gi");
      return count + (text.match(regex) || []).length;
    }, 0);
  }

  // ── Persistence ────────────────────────────────────────────────

  private persistQualityMetrics(result: SummaryResult): void {
    try {
      const dir = this.config.dataDir;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const metricsPath = join(dir, "quality-metrics.jsonl");
      const entry = {
        timestamp: new Date().toISOString(),
        originalTokens: result.originalTokens,
        summaryTokens: result.summaryTokens,
        compressionRatio: result.compressionRatio,
        retentionScore: result.quality.retentionScore,
        filePathsKept: result.quality.filePathsKept.length,
        filePathsLost: result.quality.filePathsLost.length,
        errorsKept: result.quality.errorsKept.length,
        errorsLost: result.quality.errorsLost.length,
        decisionsKept: result.quality.decisionsKept,
      };

      const existing = existsSync(metricsPath) ? readFileSync(metricsPath, "utf-8") : "";
      writeFileSync(metricsPath, existing + JSON.stringify(entry) + "\n");
    } catch {
      // Non-fatal - don't break summarization if persistence fails
    }
  }
}
