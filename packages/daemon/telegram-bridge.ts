/**
 * Telegram Bridge - Connects Telegram to the daemon's WebSocket gateway.
 *
 * Polls Telegram for messages, routes them to the daemon as prompts,
 * streams events back as Telegram messages. Runs inside the Vessel container
 * alongside the daemon process.
 *
 * This gives Eight full autonomous capability via Telegram:
 * - Natural language prompts (routed to agent with all tools)
 * - /run <cmd> for direct shell execution
 * - /status for daemon health
 * - /deploy for Vercel/Fly deployments
 * - Startup notification: "I'm online. What do we work on next?"
 */

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_MSG_LENGTH = 4000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

interface BridgeConfig {
  telegramToken: string;
  chatId: string;
  daemonUrl: string; // ws://localhost:18789 (same container)
  authToken?: string;
  devGroupId?: string; // Optional dev group for verbose logs
}

async function tgSend(token: string, chatId: string, text: string, parseMode = "Markdown"): Promise<void> {
  // Split long messages
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_MSG_LENGTH);
    if (splitAt < 100) splitAt = MAX_MSG_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    try {
      await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: parseMode,
        }),
      });
    } catch {
      // Retry without parse mode if markdown fails
      await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }).catch(() => {});
    }
  }
}

async function tgTyping(token: string, chatId: string): Promise<void> {
  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

// Import CoS router lazily to avoid circular deps
let CoSRouterClass: typeof import("./cos-router").CoSRouter | null = null;

class TelegramDaemonBridge {
  private config: BridgeConfig;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private lastUpdateId = 0;
  private polling = false;
  private agentReady = false;
  private agentBusy = false;
  private pendingApprovals = new Map<string, { tool: string; input: unknown }>();
  private cosRouter: InstanceType<typeof import("./cos-router").CoSRouter> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("[telegram-bridge] starting...");

    // Connect to daemon WebSocket
    await this.connectDaemon();

    // Initialize CoS router for CEO command handling
    try {
      const { CoSRouter } = await import("./cos-router");
      const { NotificationDispatcher } = await import("./notifications");
      const { AgentPool } = await import("./agent-pool");

      // Get the pool from the daemon (create a separate one for delegations)
      const cosPool = new AgentPool({
        model: process.env.DEFAULT_MODEL || "auto:free",
        runtime: (process.env.DEFAULT_RUNTIME as any) || "openrouter",
        workingDirectory: process.env.HOME ? `${process.env.HOME}/.8gent/workspace` : "/app",
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      const notifications = new NotificationDispatcher(
        this.config.telegramToken,
        this.config.chatId,
        this.config.devGroupId
      );

      this.cosRouter = new CoSRouter({ pool: cosPool, notifications });
      console.log("[telegram-bridge] CoS router initialized");
    } catch (err) {
      console.error("[telegram-bridge] CoS router failed to initialize:", err);
    }

    // Send startup message (direct to Telegram, not through agent)
    await tgSend(
      this.config.telegramToken,
      this.config.chatId,
      "Eight is online. Commands: /delegate, /status, /review, /plan, /goals\n\nWhat do we work on next?"
    );

    // Wait for agent to finish initializing (AST indexing takes ~5s)
    console.log("[telegram-bridge] waiting for agent initialization...");
    await new Promise((r) => setTimeout(r, 8000));
    this.agentReady = true;
    console.log("[telegram-bridge] agent ready, accepting messages");

    // Start Telegram polling
    this.polling = true;
    this.poll();

    console.log("[telegram-bridge] ready - polling Telegram, connected to daemon");
  }

  private async connectDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.config.daemonUrl;
      console.log(`[telegram-bridge] connecting to daemon at ${url}`);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log("[telegram-bridge] daemon connected");

        // Auth if needed
        if (this.config.authToken) {
          this.ws!.send(JSON.stringify({ type: "auth", token: this.config.authToken }));
        }

        // Create a session
        this.ws!.send(JSON.stringify({ type: "session:create", channel: "telegram" }));
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        this.handleDaemonMessage(msg);

        // Resolve on session creation
        if (msg.type === "session:created") {
          this.sessionId = msg.sessionId;
          console.log(`[telegram-bridge] session ${this.sessionId}`);
          resolve();
        }
      };

      this.ws.onerror = (err) => {
        console.error("[telegram-bridge] daemon connection error:", err);
        reject(err);
      };

      this.ws.onclose = () => {
        console.log("[telegram-bridge] daemon disconnected, reconnecting in 5s...");
        setTimeout(() => this.connectDaemon().catch(console.error), 5000);
      };
    });
  }

  private handleDaemonMessage(msg: any): void {
    if (msg.type !== "event") return;

    const { event, payload } = msg;

    switch (event) {
      case "agent:stream":
        if (payload.final && payload.chunk) {
          this.agentBusy = false;
          tgSend(this.config.telegramToken, this.config.chatId, payload.chunk);
        }
        break;

      case "agent:error":
        this.agentBusy = false;
        tgSend(
          this.config.telegramToken,
          this.config.chatId,
          `Error: ${payload.error}`
        );
        break;

      case "session:end":
        this.agentBusy = false;
        break;

      case "approval:required":
        // NemoClaw-style operator approval via Telegram
        this.sendApprovalRequest(payload);
        break;

      case "tool:start":
        tgTyping(this.config.telegramToken, this.config.chatId);
        break;
    }
  }

  private async poll(): Promise<void> {
    while (this.polling) {
      try {
        const res = await fetch(
          `${TELEGRAM_API}${this.config.telegramToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
          { signal: AbortSignal.timeout(35000) }
        );
        const data = await res.json();

        if (data.ok && data.result) {
          for (const update of data.result as TelegramUpdate[]) {
            this.lastUpdateId = update.update_id;
            if (update.callback_query) {
              await this.handleCallbackQuery(update.callback_query);
            } else if (update.message?.text) {
              await this.handleTelegramMessage(update.message.text, update.message.chat.id);
            }
          }
        }
      } catch (err) {
        // Timeout or network error - just retry
        if (String(err).includes("abort")) continue;
        console.error("[telegram-bridge] poll error:", err);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async handleTelegramMessage(text: string, chatId: number): Promise<void> {
    // Only respond to the configured chat
    if (String(chatId) !== this.config.chatId) return;

    // Show typing
    await tgTyping(this.config.telegramToken, this.config.chatId);

    // CEO commands via CoS router (delegate, plan, review, goals, kill)
    if (this.cosRouter) {
      const handled = await this.cosRouter.handleCommand(text, chatId);
      if (handled) return;
    }

    // Handle built-in commands
    if (text.startsWith("/status")) {
      try {
        const res = await fetch(this.config.daemonUrl.replace("ws", "http").replace("wss", "https").replace(/:\d+/, ":18789") + "/health");
        const health = await res.json();
        await tgSend(
          this.config.telegramToken,
          this.config.chatId,
          `*Eight Status*\nSessions: ${health.sessions}\nUptime: ${Math.round(health.uptime)}s\nStatus: ${health.status}`
        );
      } catch {
        await tgSend(this.config.telegramToken, this.config.chatId, "Could not reach daemon health endpoint.");
      }
      return;
    }

    if (text === "/help") {
      await tgSend(
        this.config.telegramToken,
        this.config.chatId,
        "*Eight - Telegram Bridge*\n\nSend any message to chat with Eight.\n\n/status - Daemon health\n/help - This message\n\nEight has full tool access: shell, git, file system, web browsing."
      );
      return;
    }

    // Route everything else as a prompt to the daemon
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await tgSend(this.config.telegramToken, this.config.chatId, "Daemon not connected. Reconnecting...");
      await this.connectDaemon().catch(() => {});
      return;
    }

    if (this.agentBusy) {
      await tgSend(this.config.telegramToken, this.config.chatId, "Still working on the previous request. I'll get to this next.");
      return;
    }

    this.agentBusy = true;
    this.ws.send(JSON.stringify({ type: "prompt", text }));
  }

  private async sendApprovalRequest(payload: any): Promise<void> {
    const { requestId, tool, input } = payload;
    this.pendingApprovals.set(requestId, { tool, input });

    const inputPreview = typeof input === "string"
      ? input.slice(0, 200)
      : JSON.stringify(input).slice(0, 200);

    try {
      await fetch(`${TELEGRAM_API}${this.config.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: `*Permission Required*\n\nTool: \`${tool}\`\nAction: ${inputPreview}`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "Approve", callback_data: `approve:${requestId}` },
              { text: "Deny", callback_data: `deny:${requestId}` },
            ]],
          },
        }),
      });
    } catch (err) {
      console.error("[telegram-bridge] failed to send approval request:", err);
    }
  }

  private async handleCallbackQuery(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const data = query.data || "";
    const [action, requestId] = data.split(":");

    // Answer the callback to remove the loading spinner
    await fetch(`${TELEGRAM_API}${this.config.telegramToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: query.id }),
    }).catch(() => {});

    if (!requestId || !this.pendingApprovals.has(requestId)) {
      return;
    }

    const approval = this.pendingApprovals.get(requestId)!;
    this.pendingApprovals.delete(requestId);

    const approved = action === "approve";
    const statusText = approved ? "Approved" : "Denied";

    // Update the message to show the decision
    if (query.message) {
      await fetch(`${TELEGRAM_API}${this.config.telegramToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: `*${statusText}:* \`${approval.tool}\``,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    // Send the approval decision back to the daemon
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "approval:response",
        requestId,
        approved,
      }));
    }
  }

  stop(): void {
    this.polling = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────

if (import.meta.main) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error("[telegram-bridge] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required");
    process.exit(1);
  }

  const bridge = new TelegramDaemonBridge({
    telegramToken: token,
    chatId,
    daemonUrl: process.env.DAEMON_URL || "ws://localhost:18789",
    authToken: process.env.DAEMON_AUTH_TOKEN,
    devGroupId: process.env.TELEGRAM_DEV_GROUP_ID,
  });

  bridge.start().catch((err) => {
    console.error("[telegram-bridge] fatal:", err);
    process.exit(1);
  });

  process.on("SIGTERM", () => bridge.stop());
  process.on("SIGINT", () => bridge.stop());
}
