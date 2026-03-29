/** @8gent/channels - Telegram Adapter (wraps @8gent/telegram-bot) */

import type { ChannelAdapter, ChannelMessage } from "../types";
import { TelegramBot } from "../../telegram-bot";

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;
  readonly maxMessageLength = 4096;

  private bot: TelegramBot;
  private listeners: Array<(msg: ChannelMessage) => void> = [];
  private polling = false;

  constructor(bot?: TelegramBot) {
    this.bot = bot ?? new TelegramBot();
  }

  async connect(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    // Start polling in background - the bot handles its own loop
    this.bot.startPolling().catch((err) => {
      console.error(`[channels/telegram] Polling error: ${err.message}`);
      this.polling = false;
    });
  }

  async disconnect(): Promise<void> {
    this.bot.stopPolling();
    this.polling = false;
  }

  async send(msg: ChannelMessage): Promise<string> {
    const messageId = await this.bot.sendMessage(msg.content, {
      parseMode: "Markdown",
    });
    return String(messageId);
  }

  onMessage(callback: (msg: ChannelMessage) => void): void {
    this.listeners.push(callback);
  }

  /** Called by external code to push a received Telegram message into the channel system. */
  pushMessage(text: string, chatId: string, senderId: string): void {
    const msg: ChannelMessage = {
      id: crypto.randomUUID(),
      channelId: chatId,
      platform: "telegram",
      senderId,
      content: text,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      listener(msg);
    }
  }

  /** Access the underlying TelegramBot for platform-specific features. */
  get underlying(): TelegramBot {
    return this.bot;
  }
}
