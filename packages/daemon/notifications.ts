/**
 * Notification Dispatcher - Routes Telegram notifications to the right chat.
 *
 * Primary chat: CEO commands, approvals, completion summaries
 * Dev group (optional): subagent progress, tool calls, verbose logs
 */

const TELEGRAM_API = "https://api.telegram.org/bot";

export type NotificationType =
  | "task-created"
  | "task-progress"
  | "task-complete"
  | "task-failed"
  | "approval-needed"
  | "daily-summary"
  | "error";

export class NotificationDispatcher {
  private token: string;
  private primaryChatId: string;
  private devGroupId: string | null;

  constructor(token: string, primaryChatId: string, devGroupId?: string) {
    this.token = token;
    this.primaryChatId = primaryChatId;
    this.devGroupId = devGroupId || null;
  }

  async notify(type: NotificationType, message: string): Promise<void> {
    const chatId = this.getChatForType(type);
    await this.send(chatId, message);
  }

  async notifyWithKeyboard(
    message: string,
    buttons: Array<{ text: string; callback_data: string }>
  ): Promise<void> {
    try {
      await fetch(`${TELEGRAM_API}${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.primaryChatId,
          text: message,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [buttons],
          },
        }),
      });
    } catch {
      // Retry without markdown
      await this.send(this.primaryChatId, message);
    }
  }

  private getChatForType(type: NotificationType): string {
    // Progress goes to dev group if available, everything else to primary
    if (type === "task-progress" && this.devGroupId) {
      return this.devGroupId;
    }
    return this.primaryChatId;
  }

  private async send(chatId: string, text: string): Promise<void> {
    // Split long messages
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      try {
        await fetch(`${TELEGRAM_API}${this.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
          }),
        });
      } catch {
        // Retry without markdown
        await fetch(`${TELEGRAM_API}${this.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        }).catch(() => {});
      }
    }
  }

  private splitMessage(text: string): string[] {
    const MAX = 4000;
    if (text.length <= MAX) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", MAX);
      if (splitAt < 100) splitAt = MAX;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
