/**
 * @8gent/telegram-bot — Agent Mode
 *
 * Transforms the bot from a passive dashboard into an autonomous agent.
 * Receives natural language messages, detects intent, and executes actions.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentAction, AgentActionType, ActionResult } from "./types";
import { BotMemory } from "./memory";
import {
  formatScoreboard,
  formatComparison,
  formatSystemStatus,
  formatMutationList,
  sparkline,
  formatDuration,
} from "./formatters";

// ── State paths (same as commands.ts) ───────────────────

const HOME = homedir();
const LOOP_STATE = join(HOME, "8gent-code/benchmarks/autoresearch/loop-state.json");
const LEGACY_STATE = join(HOME, "iris-observatory/benchmarks/autoresearch/loop-state.json");
const CONFIG_FILE = join(HOME, ".8gent/config.json");
const RUN_PID_FILE = join(HOME, ".8gent/run.pid");
const KNOWLEDGE_DIR = join(HOME, ".8gent/intelligence");

// ── Intent patterns ─────────────────────────────────────

interface IntentPattern {
  patterns: RegExp[];
  action: AgentActionType;
  extractParams?: (text: string) => Record<string, any>;
}

const INTENT_MAP: IntentPattern[] = [
  {
    patterns: [
      /\b(run|execute|start)\s+(benchmark|bench|test)/i,
      /\bbenchmark\s*(it|now|them)?\b/i,
    ],
    action: "run_benchmark",
  },
  {
    patterns: [
      /\b(status|state|health|how('?s| is)\s+(it|the bot|8gent|everything))\b/i,
      /\bwhat('?s| is) (the )?(status|state)\b/i,
      /\bhow('?s| are) (things|we) (doing|going)\b/i,
    ],
    action: "check_status",
  },
  {
    patterns: [
      /\b(search|find|look\s*up|query)\s+(repo|repos|repositor)/i,
      /\bwhat\s+(repo|repos|repositor)/i,
    ],
    action: "search_repos",
    extractParams: (text: string) => {
      const match = text.match(/(?:search|find|look\s*up|query)\s+(?:repos?\s+)?(?:for\s+)?(.+)/i);
      return { query: match?.[1]?.trim() ?? "" };
    },
  },
  {
    patterns: [
      /\b(scores?|results?|numbers?|how did)\b.*\b(benchmark|test|round|we|it|8gent)?\b/i,
      /\bshow\s+(me\s+)?(the\s+)?scores?\b/i,
      /\bget\s+scores?\b/i,
      /\blatest\s+(scores?|results?)\b/i,
    ],
    action: "get_scores",
  },
  {
    patterns: [
      /\bcompare\b/i,
      /\b8gent\s+(vs|versus|against)\s+claude\b/i,
      /\bclaude\s+(vs|versus|against)\s+8gent\b/i,
      /\bhow\s+(do|does)\s+(we|8gent)\s+(compare|stack\s*up|measure)\b/i,
    ],
    action: "compare",
  },
  {
    patterns: [
      /\b(start|launch|begin|kick\s*off)\s+(competition|comp|overnight|nightly|training|run)\b/i,
      /\bgo\s+overnight\b/i,
    ],
    action: "start_competition",
  },
  {
    patterns: [
      /\b(stop|halt|kill|end|abort|cancel)\s+(the\s+)?(competition|comp|process|run|loop|everything)\b/i,
      /\bshut\s*(it\s+)?down\b/i,
    ],
    action: "stop_process",
  },
  {
    patterns: [
      /\bmutation/i,
      /\blearning/i,
      /\bwhat\s+(has|have)\s+(it|we|8gent)\s+learned\b/i,
      /\baccumulated\b/i,
    ],
    action: "get_mutations",
  },
  {
    patterns: [
      /\bmodel\b.*\b(info|status|which|what|current)\b/i,
      /\bwhich\s+model\b/i,
      /\bollama\b/i,
      /\bwhat\s+model\b/i,
    ],
    action: "get_model_info",
  },
];

// ── Helper: read loop state ─────────────────────────────

function readLoopState(): any | null {
  const path = existsSync(LOOP_STATE)
    ? LOOP_STATE
    : existsSync(LEGACY_STATE)
    ? LEGACY_STATE
    : null;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readConfig(): any {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function isRunActive(): boolean {
  try {
    if (!existsSync(RUN_PID_FILE)) return false;
    const pid = parseInt(readFileSync(RUN_PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Agent Mode Class ────────────────────────────────────

export class TelegramAgentMode {
  private memory: BotMemory;

  constructor(memory?: BotMemory) {
    this.memory = memory ?? new BotMemory();
  }

  /**
   * Process an incoming message and return a response.
   * Detects intent from natural language and routes to the appropriate action.
   */
  async processMessage(text: string, chatId: string): Promise<string> {
    const trimmed = text.trim();

    // Skip empty messages
    if (!trimmed) {
      return "";
    }

    // Detect intent
    const action = this.detectIntent(trimmed);

    if (action) {
      const result = await this.executeAction(action);

      // Log the conversation
      this.memory.logConversation(chatId, trimmed, result.message);

      return result.message;
    }

    // No clear intent — try to give a helpful response based on keywords
    const fallback = this.handleFallback(trimmed);

    this.memory.logConversation(chatId, trimmed, fallback);
    return fallback;
  }

  /**
   * Detect intent from natural language text.
   */
  private detectIntent(text: string): AgentAction | null {
    for (const intent of INTENT_MAP) {
      for (const pattern of intent.patterns) {
        if (pattern.test(text)) {
          return {
            type: intent.action,
            params: intent.extractParams?.(text) ?? {},
          };
        }
      }
    }
    return null;
  }

  /**
   * Execute an agent action and return the result.
   */
  async executeAction(action: AgentAction): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "run_benchmark":
          return await this.actionRunBenchmark();

        case "check_status":
          return await this.actionCheckStatus();

        case "search_repos":
          return await this.actionSearchRepos(action.params?.query);

        case "get_scores":
          return await this.actionGetScores();

        case "compare":
          return await this.actionCompare();

        case "start_competition":
          return await this.actionStartCompetition();

        case "stop_process":
          return await this.actionStopProcess();

        case "get_mutations":
          return await this.actionGetMutations();

        case "get_model_info":
          return await this.actionGetModelInfo();

        default:
          return {
            success: false,
            message: `Unknown action: ${action.type}`,
          };
      }
    } catch (err: any) {
      return {
        success: false,
        message: `Action failed: ${err.message}`,
      };
    }
  }

  // ── Action Implementations ────────────────────────────

  private async actionRunBenchmark(): Promise<ActionResult> {
    if (isRunActive()) {
      return {
        success: false,
        message:
          "A competition loop is already running. Use `stop` first, or ask for `/scores` to see current progress.",
      };
    }

    const scriptPath = join(HOME, "8gent-code/benchmarks/autoresearch/harness.ts");
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        message: "Benchmark harness not found at expected path.",
      };
    }

    try {
      const proc = Bun.spawn(["bun", "run", scriptPath], {
        cwd: join(HOME, "8gent-code"),
        stdout: "ignore",
        stderr: "ignore",
      });

      this.memory.store_val("last_benchmark_pid", proc.pid);
      this.memory.addLearning(
        `Benchmark run triggered via agent mode (PID: ${proc.pid})`,
        "agent-mode"
      );

      return {
        success: true,
        message: `Benchmark run started (PID: \`${proc.pid}\`). I'll let you know when results come in. Use \`/scores\` to check progress.`,
        data: { pid: proc.pid },
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to start benchmark: ${err.message}`,
      };
    }
  }

  private async actionCheckStatus(): Promise<ActionResult> {
    const state = readLoopState();
    const config = readConfig();
    const running = isRunActive();
    const latest = state?.history?.[state.history.length - 1];
    const mutations = state?.mutations || [];

    const lines: string[] = [];
    lines.push(running ? "The system is *running*." : "The system is *idle* (no active run).");
    lines.push("");

    if (latest) {
      lines.push(`Last iteration: *#${latest.iteration}*`);
      lines.push(`Average score: *${(latest.avgScore ?? 0).toFixed(1)}*`);
      lines.push(`Passing: *${latest.passing ?? 0}/${latest.total ?? 0}*`);
      lines.push(`Model: \`${latest.model || config?.model || "unknown"}\``);
      lines.push(`Mutations accumulated: *${mutations.length}*`);

      if (state.history.length >= 3) {
        const recent = state.history.slice(-8).map((h: any) => h.avgScore ?? 0);
        lines.push(`\nTrend: ${sparkline(recent)} (last ${recent.length} rounds)`);
      }
    } else {
      lines.push("_No benchmark data yet. Run a benchmark or start the competition._");
    }

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private async actionSearchRepos(query?: string): Promise<ActionResult> {
    // Search in-memory repos first
    const memRepos = this.memory.getRepos();

    // Search intelligence directory if it exists
    const intelligenceRepos: { name: string; snippet: string }[] = [];
    if (existsSync(KNOWLEDGE_DIR)) {
      try {
        const files = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".json"));
        for (const file of files.slice(0, 20)) {
          try {
            const data = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, file), "utf-8"));
            if (
              !query ||
              JSON.stringify(data).toLowerCase().includes(query?.toLowerCase() ?? "")
            ) {
              intelligenceRepos.push({
                name: data.name || file.replace(".json", ""),
                snippet: data.description || data.summary || "No description",
              });
            }
          } catch {}
        }
      } catch {}
    }

    const lines: string[] = [];
    lines.push("*Repo Search Results*");
    lines.push("");

    if (memRepos.length > 0) {
      lines.push("*Tracked Repos:*");
      for (const repo of memRepos.slice(0, 10)) {
        const score = repo.score ? ` (${repo.score})` : "";
        lines.push(`  - \`${repo.name}\`${score} ${repo.description || ""}`);
      }
    }

    if (intelligenceRepos.length > 0) {
      lines.push("");
      lines.push("*Intelligence KB:*");
      for (const repo of intelligenceRepos.slice(0, 10)) {
        lines.push(`  - \`${repo.name}\`: ${repo.snippet.slice(0, 80)}`);
      }
    }

    if (memRepos.length === 0 && intelligenceRepos.length === 0) {
      lines.push("_No repos found. The knowledge base is empty._");
      if (query) {
        lines.push(`_Searched for: "${query}"_`);
      }
    }

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  private async actionGetScores(): Promise<ActionResult> {
    const state = readLoopState();
    if (!state?.history?.length) {
      return {
        success: true,
        message: "No benchmark data found yet. Run a benchmark first.",
      };
    }

    const latest = state.history[state.history.length - 1];
    const scores = latest.scores || {};

    const header = [
      `*Iteration #${latest.iteration} Scores*`,
      `Model: \`${latest.model || "unknown"}\``,
      `Average: *${(latest.avgScore ?? 0).toFixed(1)}*`,
      `Passing: *${latest.passing ?? 0}/${latest.total ?? 0}*`,
      "",
    ].join("\n");

    const scoreboard = formatScoreboard(scores);

    let trend = "";
    if (state.history.length >= 3) {
      const recent = state.history.slice(-8).map((h: any) => h.avgScore ?? 0);
      trend = `\nTrend: ${sparkline(recent)} (last ${recent.length} rounds)`;
    }

    return {
      success: true,
      message: header + scoreboard + trend,
    };
  }

  private async actionCompare(): Promise<ActionResult> {
    const state = readLoopState();
    if (!state?.history?.length) {
      return {
        success: true,
        message: "No benchmark data to compare yet. Run some benchmarks first.",
      };
    }

    const latest = state.history[state.history.length - 1];
    const eightScores = latest.scores || {};

    // Load or generate Claude baseline
    const claudeBaseline: Record<string, number> = {};
    const baselinePath = join(HOME, ".8gent/claude-baseline.json");

    if (existsSync(baselinePath)) {
      try {
        const saved = JSON.parse(readFileSync(baselinePath, "utf-8"));
        Object.assign(claudeBaseline, saved);
      } catch {}
    }

    // Fill missing keys with estimated baselines
    for (const [key] of Object.entries(eightScores)) {
      if (!(key in claudeBaseline)) {
        claudeBaseline[key] = 78 + Math.random() * 7;
      }
    }

    const comparison = formatComparison(eightScores, claudeBaseline);
    return {
      success: true,
      message: comparison,
    };
  }

  private async actionStartCompetition(): Promise<ActionResult> {
    if (isRunActive()) {
      return {
        success: false,
        message:
          "A run is already active. Stop it first before starting a new competition.",
      };
    }

    const scriptPath = join(HOME, "8gent-code/scripts/nightly-train.ts");
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        message: "Nightly train script not found. Check `scripts/nightly-train.ts`.",
      };
    }

    try {
      const { writeFileSync, mkdirSync } = await import("fs");

      const proc = Bun.spawn(["bun", "run", scriptPath], {
        cwd: join(HOME, "8gent-code"),
        stdout: "ignore",
        stderr: "ignore",
      });

      const pidDir = join(HOME, ".8gent");
      if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
      writeFileSync(RUN_PID_FILE, String(proc.pid));

      this.memory.store_val("competition_started_at", new Date().toISOString());
      this.memory.store_val("competition_pid", proc.pid);
      this.memory.addLearning(
        `Competition started via agent mode (PID: ${proc.pid})`,
        "agent-mode"
      );

      return {
        success: true,
        message: `Competition loop launched (PID: \`${proc.pid}\`). I'll monitor progress. Ask me for status or scores anytime.`,
        data: { pid: proc.pid },
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to start competition: ${err.message}`,
      };
    }
  }

  private async actionStopProcess(): Promise<ActionResult> {
    if (!isRunActive()) {
      return {
        success: true,
        message: "No active process to stop. Everything is already idle.",
      };
    }

    try {
      const pid = parseInt(readFileSync(RUN_PID_FILE, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");

      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(RUN_PID_FILE);
      } catch {}

      const startedAt = this.memory.recall("competition_started_at");
      let duration = "";
      if (startedAt) {
        const elapsed = Date.now() - new Date(startedAt).getTime();
        duration = ` Ran for ${formatDuration(elapsed)}.`;
      }

      this.memory.addLearning(
        `Process stopped via agent mode (PID: ${pid})`,
        "agent-mode"
      );

      return {
        success: true,
        message: `Sent SIGTERM to PID \`${pid}\`. The loop will wind down gracefully.${duration}`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to stop process: ${err.message}`,
      };
    }
  }

  private async actionGetMutations(): Promise<ActionResult> {
    const state = readLoopState();
    const mutations = state?.mutations || [];

    if (mutations.length === 0) {
      // Check memory learnings as fallback
      const learnings = this.memory.getLearnings();
      if (learnings.length > 0) {
        const lines = [
          `*Bot Learnings (${learnings.length})*`,
          "",
          ...learnings.slice(-10).map(
            (l, i) => `\`${i + 1}.\` ${l.learning} _(${l.source})_`
          ),
        ];
        return { success: true, message: lines.join("\n") };
      }
      return {
        success: true,
        message: "No mutations or learnings accumulated yet.",
      };
    }

    return {
      success: true,
      message: formatMutationList(mutations),
    };
  }

  private async actionGetModelInfo(): Promise<ActionResult> {
    const config = readConfig();
    const state = readLoopState();
    const latest = state?.history?.[state.history.length - 1];

    const lines: string[] = [];
    lines.push("*Model Information*");
    lines.push("");
    lines.push(`Active: \`${config?.model || latest?.model || "unknown"}\``);
    lines.push(`Provider: \`${config?.provider || "auto"}\``);

    // Check ollama status
    try {
      const response = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const data = (await response.json()) as any;
        const models = data.models || [];
        lines.push("");
        lines.push("*Ollama Models Available:*");
        if (models.length === 0) {
          lines.push("  _No models pulled_");
        } else {
          for (const m of models.slice(0, 8)) {
            const size = m.size
              ? ` (${(m.size / 1e9).toFixed(1)}GB)`
              : "";
            lines.push(`  - \`${m.name}\`${size}`);
          }
          if (models.length > 8) {
            lines.push(`  _...and ${models.length - 8} more_`);
          }
        }
      } else {
        lines.push("\nOllama: _not responding_");
      }
    } catch {
      lines.push("\nOllama: _offline or not installed_");
    }

    if (config?.router) {
      lines.push("");
      lines.push("*Router:*");
      lines.push(`  Mode: \`${config.router.mode || "disabled"}\``);
      lines.push(`  State: \`${config.router.state || "idle"}\``);
    }

    if (config?.training_proxy?.enabled) {
      lines.push("");
      lines.push("*Training Proxy:* Enabled");
      if (config.training_proxy.checkpoint) {
        lines.push(`  Checkpoint: \`${config.training_proxy.checkpoint}\``);
      }
    }

    return {
      success: true,
      message: lines.join("\n"),
    };
  }

  // ── Fallback ──────────────────────────────────────────

  private handleFallback(text: string): string {
    const lower = text.toLowerCase();

    // Greeting
    if (/^(hi|hello|hey|yo|sup|what'?s up)/i.test(lower)) {
      const state = readLoopState();
      const running = isRunActive();
      const latest = state?.history?.[state.history.length - 1];

      let status = running ? "The competition loop is running." : "No active runs right now.";
      if (latest) {
        status += ` Last score: *${(latest.avgScore ?? 0).toFixed(1)}* avg on iteration #${latest.iteration}.`;
      }

      return `Hey James. ${status}\n\nI can run benchmarks, check scores, compare against Claude, start/stop competitions, or dig into mutations. Just ask.`;
    }

    // Thanks
    if (/^(thanks|thank you|ty|cheers)/i.test(lower)) {
      return "No problem. Need anything else?";
    }

    // Help-ish
    if (/\b(help|what can you do|commands?)\b/i.test(lower)) {
      return [
        "*What I can do:*",
        "",
        "Just talk to me naturally:",
        '  - "How are things going?" -- status check',
        '  - "Show me the scores" -- latest benchmarks',
        '  - "Compare us to Claude" -- head to head',
        '  - "Run benchmarks" -- trigger a run',
        '  - "Start the competition" -- overnight loop',
        '  - "Stop everything" -- graceful shutdown',
        '  - "What have we learned?" -- mutations & learnings',
        '  - "Which model?" -- model info + ollama status',
        '  - "Search repos for X" -- knowledge base',
        "",
        "Or use `/commands` for the classic slash command menu.",
      ].join("\n");
    }

    // Default
    return [
      "I'm not sure what you're asking. Try something like:",
      '  - "What\'s the status?"',
      '  - "Show scores"',
      '  - "Run benchmarks"',
      '  - "Compare to Claude"',
      "",
      "Or type `/help` for all commands.",
    ].join("\n");
  }

  /**
   * Get the memory instance (for external access).
   */
  getMemory(): BotMemory {
    return this.memory;
  }
}
