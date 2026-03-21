/**
 * unified-portal.ts — The Single Telegram Portal to All Automation
 *
 * Inspired by Karpathy's "single WhatsApp portal" concept.
 * Routes ALL agent control through one Telegram bot interface.
 *
 * Zero external deps. Uses fetch() for Telegram API. Bot token from constructor only.
 *
 * Handlers are stubs returning formatted placeholder text.
 * Actual integration with other packages (kernel, orchestration, harness, etc.)
 * happens at the app level by replacing handlers via registerCommand().
 */

// ── Types ──────────────────────────────────────────────────────────

export interface PortalCommand {
  /** Slash command name, e.g. "/deploy", "/status" */
  command: string;
  /** Human-readable description shown in /help */
  description: string;
  /** Handler receives parsed args and the chat ID, returns formatted response text */
  handler: (args: string[], chatId: string) => Promise<string>;
  /** If true, portal sends a confirmation button before executing */
  requiresConfirmation: boolean;
}

interface InlineButton {
  text: string;
  callbackData: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: any;
  description?: string;
}

// ── Telegram Formatter ─────────────────────────────────────────────

/**
 * Format structured data as Telegram-friendly MarkdownV2.
 * Handles objects, arrays, primitives, and nested structures.
 * Uses bold headers, code blocks, and monospace for readability.
 */
export function formatForTelegram(data: any): string {
  if (data === null || data === undefined) return "_empty_";
  if (typeof data === "string") return escapeMarkdown(data);
  if (typeof data === "number" || typeof data === "boolean") return `\`${data}\``;

  if (Array.isArray(data)) {
    if (data.length === 0) return "_empty list_";
    return data
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return formatObject(item, `#${i + 1}`);
        }
        return `  ${i + 1}. ${formatForTelegram(item)}`;
      })
      .join("\n");
  }

  if (typeof data === "object") {
    return formatObject(data);
  }

  return String(data);
}

function formatObject(obj: Record<string, any>, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(`*${escapeMarkdown(header)}*`);

  for (const [key, value] of Object.entries(obj)) {
    const label = escapeMarkdown(key);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`*${label}:*`);
      for (const [k2, v2] of Object.entries(value)) {
        lines.push(`  ${escapeMarkdown(k2)}: \`${v2}\``);
      }
    } else if (Array.isArray(value)) {
      lines.push(`*${label}:* ${value.map((v) => `\`${v}\``).join(", ")}`);
    } else {
      lines.push(`*${label}:* \`${value}\``);
    }
  }
  return lines.join("\n");
}

/** Escape special chars for Telegram MarkdownV2 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ── Unified Portal ─────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_MSG_LEN = 4096;

export class UnifiedPortal {
  private botToken: string;
  private allowedChatIds: Set<string>;
  private commands: Map<string, PortalCommand> = new Map();
  private pendingConfirmations: Map<string, { command: string; args: string[] }> = new Map();

  constructor(botToken: string, allowedChatIds: string[]) {
    this.botToken = botToken;
    this.allowedChatIds = new Set(allowedChatIds);

    // Register built-in commands
    this.registerBuiltins();
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Register a command handler. Overwrites any existing handler for the same command.
   * Command string should include the leading slash, e.g. "/deploy".
   */
  registerCommand(cmd: PortalCommand): void {
    const normalized = cmd.command.startsWith("/") ? cmd.command : `/${cmd.command}`;
    this.commands.set(normalized, { ...cmd, command: normalized });
  }

  /** List all registered commands */
  getCommands(): PortalCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Route an incoming message to the appropriate handler.
   * Returns the response text. Rejects unauthorized chat IDs.
   */
  async handleMessage(text: string, chatId: string): Promise<string> {
    // Auth check
    if (!this.allowedChatIds.has(chatId)) {
      return "Unauthorized. This portal is locked to specific chat IDs.";
    }

    const trimmed = text.trim();

    // Handle confirmation callbacks
    if (trimmed === "/confirm") {
      return this.executeConfirmation(chatId);
    }
    if (trimmed === "/cancel") {
      this.pendingConfirmations.delete(chatId);
      return "Cancelled.";
    }

    // Parse command and args
    const parts = trimmed.split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);

    if (!command.startsWith("/")) {
      return "Send a /command. Try /help for the full list.";
    }

    const entry = this.commands.get(command);
    if (!entry) {
      return `Unknown command: \`${command}\`\nTry /help for available commands.`;
    }

    // If command requires confirmation, stage it
    if (entry.requiresConfirmation) {
      this.pendingConfirmations.set(chatId, { command, args });
      return (
        `*Confirm:* \`${command} ${args.join(" ")}\`\n\n` +
        `Send /confirm to execute or /cancel to abort.`
      );
    }

    return entry.handler(args, chatId);
  }

  /** Send a proactive notification to a chat */
  async sendNotification(chatId: string, message: string): Promise<void> {
    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
    });
  }

  /** Send a message with inline keyboard buttons */
  async sendWithButtons(
    chatId: string,
    text: string,
    buttons: InlineButton[][]
  ): Promise<void> {
    const keyboard = buttons.map((row) =>
      row.map((btn) => ({
        text: btn.text,
        callback_data: btn.callbackData,
      }))
    );

    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  private async executeConfirmation(chatId: string): Promise<string> {
    const pending = this.pendingConfirmations.get(chatId);
    if (!pending) {
      return "Nothing pending confirmation.";
    }

    this.pendingConfirmations.delete(chatId);
    const entry = this.commands.get(pending.command);
    if (!entry) return "Command no longer registered.";

    return entry.handler(pending.args, chatId);
  }

  private async apiCall(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse> {
    const url = `${TELEGRAM_API}${this.botToken}/${method}`;

    // Split long messages
    if (method === "sendMessage" && typeof body.text === "string" && body.text.length > MAX_MSG_LEN) {
      const chunks = splitMessage(body.text as string);
      let lastResult: TelegramApiResponse = { ok: false };
      for (const chunk of chunks) {
        lastResult = await this.rawFetch(url, { ...body, text: chunk });
      }
      return lastResult;
    }

    return this.rawFetch(url, body);
  }

  private async rawFetch(url: string, body: Record<string, unknown>): Promise<TelegramApiResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as TelegramApiResponse;
  }

  // ── Built-in Command Stubs ───────────────────────────────────────

  private registerBuiltins(): void {
    this.registerCommand({
      command: "/status",
      description: "Show running agents, benchmark progress, system health",
      requiresConfirmation: false,
      handler: async (_args, _chatId) => {
        // Integration point: pull from kernel, orchestration, harness
        // Needs: kernel.getRunningAgents(), orchestration.getActiveTasks(),
        //        harness.getCurrentProgress(), os.cpuUsage(), os.memUsage()
        return [
          "*System Status*",
          "",
          "*Agents:* `3 active`",
          "  - benchmark-runner: `idle`",
          "  - code-reviewer: `processing PR #42`",
          "  - overnight-loop: `sleeping`",
          "",
          "*Benchmarks:* `tier-3 agentic @ iter 5`",
          "  Progress: `5/7 benchmarks complete`",
          "",
          "*System:*",
          "  CPU: `23%` | RAM: `4.2GB/16GB`",
          "  Uptime: `14h 32m`",
          "",
          "_Stub response. Wire to kernel + orchestration packages._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/agents",
      description: "List active worktree agents and their tasks",
      requiresConfirmation: false,
      handler: async (_args, _chatId) => {
        // Integration point: pull from orchestration.getWorktreeAgents()
        // Needs: agent name, worktree path, current task, duration, token usage
        return [
          "*Active Agents*",
          "",
          "`agent-01` | feature/auth-refactor",
          "  Task: Refactor session middleware",
          "  Running: `2h 14m` | Tokens: `45.2k`",
          "",
          "`agent-02` | fix/memory-leak",
          "  Task: Investigate heap growth in polling loop",
          "  Running: `0h 38m` | Tokens: `12.8k`",
          "",
          "`agent-03` | benchmark/tier5",
          "  Task: Battle-test BT006-BT010",
          "  Running: `6h 02m` | Tokens: `210.4k`",
          "",
          "_Stub response. Wire to orchestration.getWorktreeAgents()._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/benchmark",
      description: "Show latest benchmark scores",
      requiresConfirmation: false,
      handler: async (args, _chatId) => {
        // Integration point: read from benchmarks/autoresearch/loop-state.json
        // Needs: category scores, iteration number, best scores, trend
        // Optional arg: category name to filter (e.g. /benchmark agentic)
        const category = args[0] || "all";
        return [
          `*Benchmark Scores* (${category})`,
          "",
          "```",
          "Category    | Best | Last | Trend",
          "------------|------|------|------",
          "bug-fixing  |  95  |  92  |  -3",
          "fullstack   |  79  |  71  |  -8",
          "agentic     |  73  |  55  |  -18",
          "ui-design   |  --  |  --  |  --",
          "battle-test |  --  |  --  |  --",
          "```",
          "",
          `_Stub response. Wire to loop-state.json reader._`,
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/deploy",
      description: "Trigger deployment for a project (requires confirmation)",
      requiresConfirmation: true,
      handler: async (args, _chatId) => {
        // Integration point: trigger deployment pipeline
        // Needs: project name from args[0], deploy target (staging/prod),
        //        git branch, commit hash
        const project = args[0] || "unknown";
        const target = args[1] || "staging";
        return [
          `*Deploying* \`${project}\` to \`${target}\``,
          "",
          "Branch: `main`",
          "Commit: `abc1234`",
          "Pipeline: `starting...`",
          "",
          "_Stub response. Wire to deployment pipeline._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/throughput",
      description: "Show token throughput stats",
      requiresConfirmation: false,
      handler: async (_args, _chatId) => {
        // Integration point: aggregate from harness token tracking
        // Needs: tokens per benchmark run, tokens per hour, cost estimate,
        //        model distribution (which free models got routed)
        return [
          "*Token Throughput*",
          "",
          "Last 24h:",
          "  Prompt tokens: `1.2M`",
          "  Completion tokens: `340k`",
          "  Total: `1.54M`",
          "",
          "Model distribution:",
          "  gemini-3-pro-preview: `68%`",
          "  gemini-2.5-flash-lite: `32%`",
          "",
          "Cost: `$0.00` (free tier only)",
          "",
          "_Stub response. Wire to harness token tracking._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/scorecard",
      description: "Show ability scorecards",
      requiresConfirmation: false,
      handler: async (args, _chatId) => {
        // Integration point: pull from personality/ability scoring
        // Needs: ability dimensions, scores, trend, calibration date
        // Optional arg: agent name to filter
        const agent = args[0] || "8gent";
        return [
          `*Scorecard:* \`${agent}\``,
          "",
          "```",
          "Ability          | Score | Grade",
          "-----------------|-------|------",
          "Code generation  |  82   |  B+",
          "Bug fixing       |  91   |  A-",
          "Architecture     |  67   |  C+",
          "Testing          |  74   |  B",
          "Documentation    |  58   |  C-",
          "Multi-file coord |  45   |  D+",
          "```",
          "",
          "Overall: `69.5` (B-)",
          "",
          "_Stub response. Wire to personality scorecard._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/soul",
      description: "Show current persona calibration",
      requiresConfirmation: false,
      handler: async (_args, _chatId) => {
        // Integration point: pull from personality/persona config
        // Needs: persona name, voice settings, temperature, system prompt hash,
        //        personality traits, last calibration timestamp
        return [
          "*Persona Calibration*",
          "",
          "Name: `8gent`",
          "Voice: `analytical, direct`",
          "Temperature: `0.7`",
          "System prompt: `v2.4 (sha: 9f3a...)`",
          "",
          "Traits:",
          "  Directness: `0.9`",
          "  Humor: `0.3`",
          "  Verbosity: `0.4`",
          "  Creativity: `0.6`",
          "",
          "Last calibrated: `2h ago`",
          "",
          "_Stub response. Wire to personality config._",
        ].join("\n");
      },
    });

    this.registerCommand({
      command: "/help",
      description: "List all available commands",
      requiresConfirmation: false,
      handler: async (_args, _chatId) => {
        const lines = [
          "*8gent Unified Portal*",
          "_The single Telegram portal to all automation._",
          "",
        ];

        const sorted = Array.from(this.commands.values()).sort((a, b) =>
          a.command.localeCompare(b.command)
        );

        for (const cmd of sorted) {
          const confirm = cmd.requiresConfirmation ? " (confirms)" : "";
          lines.push(`\`${cmd.command}\` — ${cmd.description}${confirm}`);
        }

        lines.push("");
        lines.push("_Commands with (confirms) require /confirm before execution._");

        return lines.join("\n");
      },
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number = MAX_MSG_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
