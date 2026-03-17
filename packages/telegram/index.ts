/**
 * 8gent Code - Telegram Control Interface
 *
 * Full agent control from Telegram — not a chatbot, a command center.
 * Inline keyboards, callback queries, persistent menus, rich status panels.
 *
 * Setup: /telegram <bot-token>
 * Or env: EIGHT_GENT_TELEGRAM_TOKEN
 *
 * Features:
 * - Inline keyboard control panel (model switch, tasks, skills)
 * - Callback query handling (buttons update in-place)
 * - Bot commands registered in Telegram's menu
 * - /btw side questions (ephemeral, no tools)
 * - Full agent.chat() with tool execution
 * - Rate limiting & user whitelist
 * - Typing indicators during processing
 * - Message chunking for long responses
 * - Proactive notifications
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramConfig {
  token: string;
  allowedUsers?: number[];
  allowedUsernames?: string[];
  rateLimit: number;
  maxMessageLength: number;
}

interface UserRateTracker {
  timestamps: number[];
}

// ============================================
// Config persistence
// ============================================

const CONFIG_DIR = path.join(os.homedir(), ".8gent");
const CONFIG_FILE = path.join(CONFIG_DIR, "telegram.json");

function loadConfig(): TelegramConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveConfig(config: TelegramConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============================================
// Telegram API Layer
// ============================================

const API_BASE = "https://api.telegram.org/bot";

async function api(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const url = `${API_BASE}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram ${method} (${response.status}): ${text}`);
  }

  const json = (await response.json()) as any;
  if (!json.ok) throw new Error(`Telegram: ${json.description}`);
  return json.result;
}

// Convenience wrappers
async function sendMsg(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: any,
  parseMode: string = "Markdown"
): Promise<any> {
  const MAX_LEN = 4000;

  // For short messages, send with keyboard
  if (text.length <= MAX_LEN) {
    try {
      return await api(token, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
    } catch {
      // Fallback without parse mode
      return await api(token, "sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
      });
    }
  }

  // Split long messages
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > MAX_LEN) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  let lastResult: any;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    try {
      lastResult = await api(token, "sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: parseMode,
        reply_markup: isLast ? replyMarkup : undefined,
      });
    } catch {
      lastResult = await api(token, "sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        reply_markup: isLast ? replyMarkup : undefined,
      });
    }
  }
  return lastResult;
}

async function editMsg(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: any
): Promise<void> {
  try {
    await api(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });
  } catch {
    await api(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
    }).catch(() => {});
  }
}

async function answerCallback(token: string, queryId: string, text?: string, showAlert = false): Promise<void> {
  await api(token, "answerCallbackQuery", {
    callback_query_id: queryId,
    text,
    show_alert: showAlert,
    cache_time: 0,
  });
}

async function getUpdates(token: string, offset: number, timeout = 30): Promise<TelegramUpdate[]> {
  return api(token, "getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message", "callback_query"],
  });
}

async function getMe(token: string): Promise<{ id: number; first_name: string; username: string }> {
  return api(token, "getMe");
}

// ============================================
// Keyboard Builders
// ============================================

function buildControlPanel(agent: any): { text: string; keyboard: any } {
  const model = agent?.getModel?.() ?? "unknown";
  const history = agent?.getHistoryLength?.() ?? 0;
  const uptime = agent ? Math.round((Date.now() - (agent.sessionStartTime ?? Date.now())) / 60000) : 0;

  const text = [
    "🤖 *8gent Code — Control Panel*",
    "",
    `📡 Status: ✅ Online`,
    `🧠 Model: \`${model}\``,
    `💬 History: ${history} messages`,
    `⏱ Uptime: ${uptime}m`,
    "",
    "_Tap a button below to control the agent._",
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "panel:refresh" },
        { text: "🗑 Clear History", callback_data: "panel:clear" },
      ],
      [
        { text: "🧠 Switch Model ▸", callback_data: "menu:models" },
      ],
      [
        { text: "📋 Tasks", callback_data: "menu:tasks" },
        { text: "🛠 Skills", callback_data: "menu:skills" },
      ],
      [
        { text: "📊 Benchmark Status", callback_data: "panel:benchmark" },
      ],
      [
        { text: "💭 Quick /btw", callback_data: "panel:btw_prompt" },
        { text: "⏹ Stop Agent", callback_data: "panel:stop" },
      ],
    ],
  };

  return { text, keyboard };
}

function buildModelMenu(): { text: string; keyboard: any } {
  const text = "🧠 *Select a model:*\n\n_Choose your provider and model. The agent will switch immediately._";

  const keyboard = {
    inline_keyboard: [
      [{ text: "── Local (Ollama) ──", callback_data: "noop" }],
      [
        { text: "Qwen3 14B", callback_data: "model:qwen3:14b" },
        { text: "Qwen3 32B", callback_data: "model:qwen3:32b" },
      ],
      [
        { text: "DeepSeek V3", callback_data: "model:deepseek-coder-v3" },
        { text: "Codestral", callback_data: "model:codestral:latest" },
      ],
      [{ text: "── Cloud (OpenRouter) ──", callback_data: "noop" }],
      [
        { text: "Claude Sonnet 4", callback_data: "model:anthropic/claude-sonnet-4" },
        { text: "Claude Opus 4", callback_data: "model:anthropic/claude-opus-4" },
      ],
      [
        { text: "GPT-4.1", callback_data: "model:openai/gpt-4.1" },
        { text: "Gemini 2.5 Pro", callback_data: "model:google/gemini-2.5-pro" },
      ],
      [
        { text: "Auto (Free)", callback_data: "model:openrouter/auto" },
      ],
      [{ text: "◀ Back", callback_data: "panel:main" }],
    ],
  };

  return { text, keyboard };
}

function buildTasksMenu(agent: any): { text: string; keyboard: any } {
  // Try to get background tasks
  let taskLines = "No background tasks running.";
  try {
    const taskMgr = agent?.executor?.backgroundTaskManager;
    if (taskMgr) {
      const tasks = taskMgr.listTasks({ limit: 5 });
      if (tasks.length > 0) {
        taskLines = tasks
          .map((t: any) => {
            const icon = t.status === "running" ? "🟢" : t.status === "completed" ? "✅" : "🔴";
            return `${icon} \`${t.id}\` — ${t.command?.slice(0, 40)}`;
          })
          .join("\n");
      }
    }
  } catch {}

  const text = `📋 *Background Tasks*\n\n${taskLines}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "menu:tasks" },
      ],
      [{ text: "◀ Back", callback_data: "panel:main" }],
    ],
  };

  return { text, keyboard };
}

function buildSkillsMenu(agent: any): { text: string; keyboard: any } {
  let skillLines = "No skills loaded.";
  try {
    // Try to read skill index
    const indexPath = path.join(os.homedir(), ".8gent", "skills", ".index.json");
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      const cats = Object.entries(index.categories || {})
        .sort((a: any, b: any) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`)
        .join("\n");
      skillLines = `*${index.skillCount}* skills loaded (${Math.round(index.totalTokens / 1000)}k tokens)\n\n${cats}`;
    }
  } catch {}

  const text = `🛠 *Skill Registry*\n\n${skillLines}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: "menu:skills" },
      ],
      [{ text: "◀ Back", callback_data: "panel:main" }],
    ],
  };

  return { text, keyboard };
}

function buildQuickActions(): any {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "panel:main" },
        { text: "🧠 Model", callback_data: "menu:models" },
      ],
      [
        { text: "📋 Tasks", callback_data: "menu:tasks" },
        { text: "🛠 Skills", callback_data: "menu:skills" },
      ],
    ],
  };
}

// ============================================
// Bot Commands Registration
// ============================================

async function registerBotCommands(token: string): Promise<void> {
  await api(token, "setMyCommands", {
    commands: [
      { command: "start", description: "Open control panel" },
      { command: "status", description: "Agent status" },
      { command: "panel", description: "Open control panel" },
      { command: "model", description: "Switch AI model" },
      { command: "tasks", description: "Background tasks" },
      { command: "skills", description: "Show skill registry" },
      { command: "btw", description: "Quick side question" },
      { command: "run", description: "Run a shell command" },
      { command: "help", description: "Show help" },
    ],
  });
}

// ============================================
// Telegram Bot — Full Control Interface
// ============================================

export class TelegramBot {
  private config: TelegramConfig;
  private running = false;
  private offset = 0;
  private rateLimits = new Map<number, UserRateTracker>();
  private agent: any;
  private panelMessages = new Map<number, number>(); // chatId -> messageId of current panel
  public botUsername = "";

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  private isAllowed(userId: number, username?: string): boolean {
    if (!this.config.allowedUsers?.length && !this.config.allowedUsernames?.length) return true;
    if (this.config.allowedUsers?.includes(userId)) return true;
    if (username && this.config.allowedUsernames?.includes(username)) return true;
    return false;
  }

  private checkRateLimit(userId: number): boolean {
    const now = Date.now();
    let tracker = this.rateLimits.get(userId);
    if (!tracker) {
      tracker = { timestamps: [] };
      this.rateLimits.set(userId, tracker);
    }
    tracker.timestamps = tracker.timestamps.filter((t) => now - t < 60_000);
    if (tracker.timestamps.length >= this.config.rateLimit) return false;
    tracker.timestamps.push(now);
    return true;
  }

  // ── Panel Management ──────────────────────────────

  private async showPanel(chatId: number): Promise<void> {
    const { text, keyboard } = buildControlPanel(this.agent);
    const result = await sendMsg(this.config.token, chatId, text, keyboard);
    if (result?.message_id) {
      this.panelMessages.set(chatId, result.message_id);
    }
  }

  private async updatePanel(chatId: number, messageId: number): Promise<void> {
    const { text, keyboard } = buildControlPanel(this.agent);
    await editMsg(this.config.token, chatId, messageId, text, keyboard);
  }

  // ── Callback Query Handler ────────────────────────

  private async handleCallback(query: CallbackQuery): Promise<void> {
    const { id, from, message, data } = query;
    if (!data || !message) {
      await answerCallback(this.config.token, id);
      return;
    }

    const chatId = message.chat.id;
    const msgId = message.message_id;

    // Access control
    if (!this.isAllowed(from.id, from.username)) {
      await answerCallback(this.config.token, id, "Not authorized", true);
      return;
    }

    // Route callback data
    if (data === "noop") {
      await answerCallback(this.config.token, id);
      return;
    }

    if (data === "panel:main" || data === "panel:refresh") {
      await this.updatePanel(chatId, msgId);
      await answerCallback(this.config.token, id, data === "panel:refresh" ? "Refreshed" : undefined);
      return;
    }

    if (data === "panel:clear") {
      this.agent?.clearHistory?.();
      await answerCallback(this.config.token, id, "History cleared!", true);
      await this.updatePanel(chatId, msgId);
      return;
    }

    if (data === "panel:stop") {
      await answerCallback(this.config.token, id, "Agent stop not implemented yet", true);
      return;
    }

    if (data === "panel:btw_prompt") {
      await answerCallback(this.config.token, id);
      await sendMsg(
        this.config.token,
        chatId,
        "💭 Type your side question:\n\n_Reply with_ `/btw your question here`",
      );
      return;
    }

    if (data === "panel:benchmark") {
      await answerCallback(this.config.token, id);
      let benchText = "📊 *Benchmark Status*\n\nNo benchmark data found.";
      try {
        const statePath = path.join(
          os.homedir(),
          "iris-observatory",
          "benchmarks",
          "autoresearch",
          "loop-state.json"
        );
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
          const lastHistory = state.history?.[state.history.length - 1];
          if (lastHistory) {
            const scores = Object.entries(lastHistory.scores || {})
              .map(([id, score]) => {
                const icon = (score as number) >= 70 ? "✅" : (score as number) >= 40 ? "🟡" : "🔴";
                return `${icon} \`${id}\`: ${score}`;
              })
              .join("\n");
            benchText = [
              "📊 *Benchmark Status*",
              "",
              `Iteration: ${lastHistory.iteration}`,
              `Average: ${lastHistory.avgScore}`,
              `Passing: ${lastHistory.passing}/${lastHistory.total}`,
              "",
              scores,
              "",
              `_${new Date(lastHistory.timestamp).toLocaleString()}_`,
            ].join("\n");
          }
        }
      } catch {}
      await editMsg(this.config.token, chatId, msgId, benchText, {
        inline_keyboard: [[{ text: "◀ Back", callback_data: "panel:main" }]],
      });
      return;
    }

    // Model switching
    if (data.startsWith("model:")) {
      const model = data.slice(6);
      try {
        this.agent?.setModel?.(model);
        await answerCallback(this.config.token, id, `Switched to ${model}`, true);
        await this.updatePanel(chatId, msgId);
      } catch (err: any) {
        await answerCallback(this.config.token, id, `Failed: ${err.message}`, true);
      }
      return;
    }

    // Sub-menus
    if (data === "menu:models") {
      const { text, keyboard } = buildModelMenu();
      await editMsg(this.config.token, chatId, msgId, text, keyboard);
      await answerCallback(this.config.token, id);
      return;
    }

    if (data === "menu:tasks") {
      const { text, keyboard } = buildTasksMenu(this.agent);
      await editMsg(this.config.token, chatId, msgId, text, keyboard);
      await answerCallback(this.config.token, id);
      return;
    }

    if (data === "menu:skills") {
      const { text, keyboard } = buildSkillsMenu(this.agent);
      await editMsg(this.config.token, chatId, msgId, text, keyboard);
      await answerCallback(this.config.token, id);
      return;
    }

    await answerCallback(this.config.token, id, "Unknown action");
  }

  // ── Message Handler ───────────────────────────────

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg?.text) return;

    const { from, chat, text } = msg;

    // Access control
    if (!this.isAllowed(from.id, from.username)) {
      await sendMsg(this.config.token, chat.id, "⛔ Not authorized. Ask the owner to add you.");
      return;
    }

    // Rate limiting
    if (!this.checkRateLimit(from.id)) {
      await sendMsg(this.config.token, chat.id, "⏳ Rate limit hit. Wait a minute.");
      return;
    }

    // ── Bot Commands ──

    if (text === "/start" || text === "/panel") {
      await this.showPanel(chat.id);
      return;
    }

    if (text === "/status") {
      const { text: panelText, keyboard } = buildControlPanel(this.agent);
      await sendMsg(this.config.token, chat.id, panelText, keyboard);
      return;
    }

    if (text === "/model") {
      const { text: modelText, keyboard } = buildModelMenu();
      await sendMsg(this.config.token, chat.id, modelText, keyboard);
      return;
    }

    if (text === "/tasks") {
      const { text: taskText, keyboard } = buildTasksMenu(this.agent);
      await sendMsg(this.config.token, chat.id, taskText, keyboard);
      return;
    }

    if (text === "/skills") {
      const { text: skillText, keyboard } = buildSkillsMenu(this.agent);
      await sendMsg(this.config.token, chat.id, skillText, keyboard);
      return;
    }

    if (text === "/help") {
      const helpText = [
        "🤖 *8gent Code — Commands*",
        "",
        "*/panel* — Open control panel",
        "*/status* — Agent status with controls",
        "*/model* — Switch AI model",
        "*/tasks* — View background tasks",
        "*/skills* — Show skill registry",
        "*/btw <question>* — Side question (no tools)",
        "*/run <cmd>* — Execute shell command",
        "",
        "Or just type any message to chat with the agent.",
        "The agent has full tool access (file read/write, git, web, etc.)",
      ].join("\n");
      await sendMsg(this.config.token, chat.id, helpText);
      return;
    }

    // /btw — Side question
    if (text.startsWith("/btw ")) {
      const question = text.slice(5).trim();
      if (!question) {
        await sendMsg(this.config.token, chat.id, "Usage: `/btw your question here`");
        return;
      }

      // Typing indicator
      api(this.config.token, "sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});

      try {
        const answer = await this.agent.btw(question);
        await sendMsg(this.config.token, chat.id, `💭 *btw:*\n\n${answer}`, buildQuickActions());
      } catch (err: any) {
        await sendMsg(this.config.token, chat.id, `❌ ${err.message?.slice(0, 200)}`);
      }
      return;
    }

    // /run — Shell command
    if (text.startsWith("/run ")) {
      const cmd = text.slice(5).trim();
      if (!cmd) {
        await sendMsg(this.config.token, chat.id, "Usage: `/run ls -la`");
        return;
      }

      api(this.config.token, "sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});

      try {
        const proc = Bun.spawn(["bash", "-c", cmd], {
          cwd: this.agent?.getWorkingDirectory?.() ?? process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        let output = "";
        if (stdout) output += `\`\`\`\n${stdout.slice(0, 3000)}\n\`\`\``;
        if (stderr) output += `\n⚠️ stderr:\n\`\`\`\n${stderr.slice(0, 1000)}\n\`\`\``;
        output += `\n_Exit: ${exitCode}_`;

        await sendMsg(this.config.token, chat.id, output, buildQuickActions());
      } catch (err: any) {
        await sendMsg(this.config.token, chat.id, `❌ ${err.message}`);
      }
      return;
    }

    // ── Default: Full agent chat ──

    // Typing indicator (keep sending every 4s for long tasks)
    const typingInterval = setInterval(() => {
      api(this.config.token, "sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});
    }, 4000);
    api(this.config.token, "sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});

    try {
      const response = await this.agent.chat(text);
      clearInterval(typingInterval);

      // Truncate if needed
      const truncated =
        response.length > this.config.maxMessageLength
          ? response.slice(0, this.config.maxMessageLength) + "\n\n_... (truncated)_"
          : response;

      await sendMsg(this.config.token, chat.id, truncated, buildQuickActions());
    } catch (err: any) {
      clearInterval(typingInterval);
      await sendMsg(this.config.token, chat.id, `❌ Error: ${err.message?.slice(0, 200) ?? "Unknown"}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────

  async start(agent: any): Promise<void> {
    this.agent = agent;
    this.running = true;

    // Verify token & get bot info
    const me = await getMe(this.config.token);
    this.botUsername = me.username;

    // Register commands in Telegram's UI
    await registerBotCommands(this.config.token);

    console.log(`\n\x1b[36m🤖 Telegram bot connected: @${me.username}\x1b[0m`);
    console.log(`\x1b[90m   Bot ID: ${me.id} | Commands registered | Polling...\x1b[0m\n`);

    // Long-polling loop
    while (this.running) {
      try {
        const updates = await getUpdates(this.config.token, this.offset, 30);

        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleMessage(update).catch((err) => {
            console.error(`Telegram handler error: ${err.message}`);
          });
        }
      } catch (err: any) {
        if (!this.running) break;
        console.error(`Telegram polling error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("\x1b[33mTelegram bot stopped.\x1b[0m");
  }

  /**
   * Send a proactive notification to a chat
   */
  async notify(chatId: number, message: string, withPanel = false): Promise<void> {
    const markup = withPanel ? buildQuickActions() : undefined;
    await sendMsg(this.config.token, chatId, message, markup);
  }

  /**
   * Send a status update with inline controls
   */
  async sendStatusUpdate(chatId: number): Promise<void> {
    const { text, keyboard } = buildControlPanel(this.agent);
    await sendMsg(this.config.token, chatId, text, keyboard);
  }
}

// ============================================
// Module exports
// ============================================

let activeBotInstance: TelegramBot | null = null;

export async function startTelegramBot(
  token: string,
  agent: any,
  options?: {
    allowedUsers?: number[];
    allowedUsernames?: string[];
    rateLimit?: number;
  }
): Promise<TelegramBot> {
  const config: TelegramConfig = {
    token,
    allowedUsers: options?.allowedUsers,
    allowedUsernames: options?.allowedUsernames,
    rateLimit: options?.rateLimit ?? 10,
    maxMessageLength: 15000,
  };

  saveConfig(config);

  const bot = new TelegramBot(config);
  activeBotInstance = bot;

  // Start in background (non-blocking)
  bot.start(agent).catch((err) => {
    console.error(`Telegram bot crashed: ${err.message}`);
  });

  return bot;
}

export function getActiveTelegramBot(): TelegramBot | null {
  return activeBotInstance;
}

export function getSavedToken(): string | null {
  const config = loadConfig();
  return config?.token ?? process.env.EIGHT_GENT_TELEGRAM_TOKEN ?? null;
}

export async function validateToken(
  token: string
): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const me = await getMe(token);
    return { valid: true, username: me.username };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
