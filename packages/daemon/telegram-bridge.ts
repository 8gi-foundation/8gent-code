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
}

interface BridgeConfig {
  telegramToken: string;
  chatId: string;
  daemonUrl: string; // ws://localhost:18789 (same container)
  authToken?: string;
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

class TelegramDaemonBridge {
  private config: BridgeConfig;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private lastUpdateId = 0;
  private polling = false;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("[telegram-bridge] starting...");

    // Connect to daemon WebSocket
    await this.connectDaemon();

    // Start Telegram polling
    this.polling = true;
    this.poll();

    // Send startup message
    await tgSend(
      this.config.telegramToken,
      this.config.chatId,
      "Eight is online. What do we work on next?"
    );

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
          // Send the final response to Telegram
          tgSend(this.config.telegramToken, this.config.chatId, payload.chunk);
        }
        break;

      case "agent:error":
        tgSend(
          this.config.telegramToken,
          this.config.chatId,
          `Error: ${payload.error}`
        );
        break;

      case "tool:start":
        // Show typing indicator when tools run
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
            if (update.message?.text) {
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

    // Handle commands
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

    this.ws.send(JSON.stringify({ type: "prompt", text }));
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
  });

  bridge.start().catch((err) => {
    console.error("[telegram-bridge] fatal:", err);
    process.exit(1);
  });

  process.on("SIGTERM", () => bridge.stop());
  process.on("SIGINT", () => bridge.stop());
}
