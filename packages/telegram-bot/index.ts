/**
 * @8gent/telegram-bot — Main Bot Module
 *
 * Full autonomous agent bot for 8gent-code.
 * Competition scoreboard, status dashboard, agent mode for natural language tasks,
 * live-updating competition dashboards, persistent memory.
 *
 * Usage:
 *   import { TelegramBot } from "@8gent/telegram-bot";
 *   const bot = new TelegramBot();
 *   await bot.sendMessage("Hello from 8gent!");
 *   await bot.startPolling();
 */

import type {
  TelegramBotConfig,
  TelegramResponse,
  TelegramUpdate,
  CompetitionRound,
  BenchmarkReport,
  OvernightSummary,
  AlertSeverity,
  SendMessageOptions,
  InlineKeyboardMarkup,
} from "./types";

import {
  formatCompetitionRound,
  formatBenchmarkReport,
  formatMorningBrief,
  formatAlert,
  formatScoreboard,
} from "./formatters";

import { routeCommand, commands } from "./commands";
import { TelegramAgentMode } from "./agent-mode";
import { BotMemory } from "./memory";
import { LiveDashboard } from "./live-dashboard";

// ── Default credentials (env overrides) ─────────────────

const DEFAULT_TOKEN = "8651805768:AAFvSVOMc7U9l2itsBUTWPzgBkPxdle4B4U";
const DEFAULT_CHAT_ID = "5486040131";

// ── Telegram API helpers ────────────────────────────────

const API_BASE = "https://api.telegram.org/bot";
const MAX_MESSAGE_LENGTH = 4096;

async function apiCall(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<any> {
  const url = `${API_BASE}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await response.json()) as TelegramResponse;

  if (!json.ok) {
    throw new Error(`Telegram API ${method}: ${json.description ?? "Unknown error"} (${json.error_code})`);
  }

  return json.result;
}

async function apiFormData(
  token: string,
  method: string,
  formData: FormData
): Promise<any> {
  const url = `${API_BASE}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });

  const json = (await response.json()) as TelegramResponse;

  if (!json.ok) {
    throw new Error(`Telegram API ${method}: ${json.description ?? "Unknown error"}`);
  }

  return json.result;
}

/**
 * Split a long message into Telegram-safe chunks at line boundaries.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      // If a single line exceeds max, force-split it
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

// ── Main Bot Class ──────────────────────────────────────

export class TelegramBot {
  private token: string;
  private chatId: string;
  private polling: boolean = false;
  private pollOffset: number = 0;
  private pollingInterval: number;
  private abortController: AbortController | null = null;

  /** Agent mode — processes natural language messages as tasks. */
  public agentMode: TelegramAgentMode;

  /** Persistent bot memory — conversations, repos, learnings. */
  public memory: BotMemory;

  /** Live dashboard instance for real-time competition updates. */
  public liveDashboard: LiveDashboard;

  constructor(config?: Partial<TelegramBotConfig>) {
    this.token = config?.token ?? process.env.TELEGRAM_BOT_TOKEN ?? DEFAULT_TOKEN;
    this.chatId = config?.chatId ?? process.env.TELEGRAM_CHAT_ID ?? DEFAULT_CHAT_ID;
    this.pollingInterval = config?.pollingInterval ?? 30;

    this.memory = new BotMemory();
    this.agentMode = new TelegramAgentMode(this.memory);
    this.liveDashboard = new LiveDashboard(this.chatId);
  }

  // ── Core API Methods ────────────────────────────────

  /**
   * Send a text message with optional parse mode and reply markup.
   * Automatically splits messages that exceed Telegram's 4096 char limit.
   * Returns the message_id of the last sent message.
   */
  async sendMessage(
    text: string,
    options?: SendMessageOptions
  ): Promise<number> {
    const parseMode = options?.parseMode ?? "Markdown";
    const chunks = splitMessage(text);
    let lastMessageId = 0;

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      try {
        const result = await apiCall(this.token, "sendMessage", {
          chat_id: this.chatId,
          text: chunks[i],
          parse_mode: parseMode,
          reply_markup: isLast ? options?.replyMarkup : undefined,
          disable_web_page_preview: options?.disablePreview ?? true,
        });
        lastMessageId = result.message_id;
      } catch {
        // Fallback: try without parse mode (Markdown can fail on special chars)
        const result = await apiCall(this.token, "sendMessage", {
          chat_id: this.chatId,
          text: chunks[i],
          reply_markup: isLast ? options?.replyMarkup : undefined,
          disable_web_page_preview: options?.disablePreview ?? true,
        });
        lastMessageId = result.message_id;
      }
    }

    return lastMessageId;
  }

  /**
   * Send a message with an inline keyboard.
   * `buttons` is a 2D array: each inner array is a row of button labels.
   * Each button's callback_data defaults to the button text (lowercase, spaces replaced with _).
   */
  async sendWithKeyboard(
    text: string,
    buttons: string[][],
    options?: { parseMode?: "Markdown" | "HTML" }
  ): Promise<number> {
    const inlineKeyboard = buttons.map((row) =>
      row.map((label) => ({
        text: label,
        callback_data: label.toLowerCase().replace(/\s+/g, "_").slice(0, 64),
      }))
    );

    return this.sendMessage(text, {
      parseMode: options?.parseMode ?? "Markdown",
      replyMarkup: { inline_keyboard: inlineKeyboard },
    });
  }

  /**
   * Edit an existing message by message ID.
   * Useful for live-updating dashboards and status messages.
   */
  async editMessage(
    messageId: number,
    text: string,
    options?: {
      parseMode?: "Markdown" | "HTML";
      replyMarkup?: InlineKeyboardMarkup;
    }
  ): Promise<void> {
    try {
      await apiCall(this.token, "editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text,
        parse_mode: options?.parseMode ?? "Markdown",
        disable_web_page_preview: true,
        reply_markup: options?.replyMarkup,
      });
    } catch (err: any) {
      // "message is not modified" is expected if content hasn't changed
      if (!err.message?.includes("message is not modified")) {
        throw err;
      }
    }
  }

  /**
   * Send a photo with optional caption.
   * Accepts a URL string or a Buffer.
   */
  async sendPhoto(
    photo: Buffer | string,
    caption?: string
  ): Promise<void> {
    if (typeof photo === "string") {
      // URL-based photo
      await apiCall(this.token, "sendPhoto", {
        chat_id: this.chatId,
        photo,
        caption,
        parse_mode: "Markdown",
      });
    } else {
      // Buffer-based photo via FormData
      const formData = new FormData();
      formData.append("chat_id", this.chatId);
      formData.append("photo", new Blob([photo]), "image.png");
      if (caption) {
        formData.append("caption", caption);
        formData.append("parse_mode", "Markdown");
      }
      await apiFormData(this.token, "sendPhoto", formData);
    }
  }

  /**
   * Send a formatted competition round update.
   */
  async sendCompetitionUpdate(round: CompetitionRound): Promise<void> {
    const message = formatCompetitionRound(round);
    await this.sendMessage(message, { parseMode: "Markdown" });
  }

  /**
   * Send a formatted benchmark report.
   */
  async sendBenchmarkReport(report: BenchmarkReport): Promise<void> {
    const message = formatBenchmarkReport(report);
    await this.sendMessage(message, { parseMode: "Markdown" });
  }

  /**
   * Send the morning brief — the comprehensive overnight summary.
   */
  async sendMorningBrief(summary: OvernightSummary): Promise<void> {
    const message = formatMorningBrief(summary);
    await this.sendMessage(message, { parseMode: "Markdown" });
  }

  /**
   * Send an alert with severity-based formatting.
   */
  async sendAlert(
    message: string,
    severity: AlertSeverity = "info"
  ): Promise<void> {
    const formatted = formatAlert(message, severity);
    await this.sendMessage(formatted, { parseMode: "Markdown" });
  }

  // ── Polling ─────────────────────────────────────────

  /**
   * Start long-polling for incoming commands and messages.
   * Registers bot commands in Telegram's UI and begins the poll loop.
   * Non-command messages are routed to agent mode for natural language processing.
   */
  async startPolling(): Promise<void> {
    if (this.polling) {
      console.warn("[8gent-bot] Already polling.");
      return;
    }

    // Verify the token works
    const me = await apiCall(this.token, "getMe");
    console.log(`[8gent-bot] Connected as @${me.username} (${me.id})`);

    // Register commands in Telegram's menu
    await apiCall(this.token, "setMyCommands", {
      commands: commands.map((c) => ({
        command: c.name,
        description: c.description,
      })),
    });

    this.polling = true;
    this.abortController = new AbortController();

    console.log("[8gent-bot] Polling started. Agent mode active. Listening for commands and messages...");

    while (this.polling) {
      try {
        const updates: TelegramUpdate[] = await apiCall(this.token, "getUpdates", {
          offset: this.pollOffset,
          timeout: this.pollingInterval,
          allowed_updates: ["message", "callback_query"],
        });

        for (const update of updates) {
          this.pollOffset = update.update_id + 1;
          this.handleUpdate(update).catch((err) => {
            console.error(`[8gent-bot] Handler error: ${err.message}`);
          });
        }
      } catch (err: any) {
        if (!this.polling) break;
        console.error(`[8gent-bot] Poll error: ${err.message}`);
        // Back off on error
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    console.log("[8gent-bot] Polling stopped.");
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── Update Handler ──────────────────────────────────

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Handle callback queries (inline keyboard button presses)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const text = message.text;

    // Only respond to the configured chat
    if (String(chatId) !== this.chatId) {
      console.log(`[8gent-bot] Ignoring message from chat ${chatId}`);
      return;
    }

    // Send typing indicator
    apiCall(this.token, "sendChatAction", {
      chat_id: chatId,
      action: "typing",
    }).catch(() => {});

    // Route to command handler first
    const handled = await routeCommand(text, chatId, this);

    if (!handled) {
      if (text.startsWith("/")) {
        // Unknown slash command
        await this.sendMessage(
          `Unknown command: \`${text.split(/\s/)[0]}\`\n\nUse /help for available commands.`,
          { parseMode: "Markdown" }
        );
      } else {
        // Route non-command messages to agent mode
        const response = await this.agentMode.processMessage(text, String(chatId));
        if (response) {
          await this.sendMessage(response, { parseMode: "Markdown" });
        }
      }
    }
  }

  /**
   * Handle inline keyboard callback queries.
   */
  private async handleCallbackQuery(query: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  }): Promise<void> {
    // Acknowledge the callback to remove the loading spinner
    await apiCall(this.token, "answerCallbackQuery", {
      callback_query_id: query.id,
    });

    if (!query.data || !query.message) return;

    const chatId = query.message.chat.id;
    if (String(chatId) !== this.chatId) return;

    // Route callback data through agent mode as if it were a message
    const response = await this.agentMode.processMessage(query.data, String(chatId));
    if (response) {
      await this.sendMessage(response, { parseMode: "Markdown" });
    }
  }

  // ── Utility ─────────────────────────────────────────

  /**
   * Send a raw API request (for advanced use cases).
   */
  async api(method: string, body?: Record<string, unknown>): Promise<any> {
    return apiCall(this.token, method, body);
  }

  /**
   * Get the configured chat ID.
   */
  getChatId(): string {
    return this.chatId;
  }

  /**
   * Check if the bot token is valid.
   */
  async validate(): Promise<{ valid: boolean; username?: string; error?: string }> {
    try {
      const me = await apiCall(this.token, "getMe");
      return { valid: true, username: me.username };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  }
}

// ── Convenience Exports ─────────────────────────────────

/**
 * Create a bot instance with default config and send a single message.
 * Useful for scripts and cron jobs.
 */
export async function quickSend(text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
  const bot = new TelegramBot();
  await bot.sendMessage(text, { parseMode: parseMode ?? "Markdown" });
}

/**
 * Create a bot instance with default config.
 */
export function createBot(config?: Partial<TelegramBotConfig>): TelegramBot {
  return new TelegramBot(config);
}

// Re-export types and formatters for consumer convenience
export type {
  TelegramBotConfig,
  CompetitionRound,
  BenchmarkReport,
  OvernightSummary,
  AlertSeverity,
  SendMessageOptions,
  BenchmarkScore,
  TierBreakdown,
  SystemStatus,
  AgentAction,
  AgentActionType,
  ActionResult,
  DashboardData,
  ConversationEntry,
  RepoEntry,
  Learning,
  BotMemoryData,
} from "./types";

export {
  formatScoreboard,
  formatCompetitionRound,
  formatBenchmarkReport,
  formatMorningBrief,
  formatTierBreakdown,
  formatMutationList,
  formatComparison,
  formatAlert,
  formatSystemStatus,
  sparkline,
  progressBar,
  formatDuration,
  formatTokens,
} from "./formatters";

export { commands, routeCommand } from "./commands";
export { TelegramAgentMode } from "./agent-mode";
export { BotMemory } from "./memory";
export { LiveDashboard } from "./live-dashboard";
