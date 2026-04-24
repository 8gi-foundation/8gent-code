/**
 * Notification Dispatcher - Routes notifications to Telegram + macOS + Email.
 *
 * Channels:
 *   - Telegram: primary chat for commands, approvals, completion summaries
 *   - macOS: native Notification Center via osascript (session complete, approval, error)
 *   - Email: Resend API for session complete, approval, daily summary, errors
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

// ── macOS Native Notifications ──────────────────────────────────

const MACOS_NOTIFY_TYPES = new Set<NotificationType>([
  "task-complete",
  "task-failed",
  "approval-needed",
  "error",
]);

/**
 * Send a macOS native notification via osascript.
 * No dependencies required - uses built-in AppleScript.
 */
export async function sendNativeNotification(
  title: string,
  message: string,
  options: { subtitle?: string; sound?: string } = {},
): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  const sound = options.sound || "Glass";
  const subtitle = options.subtitle ? ` subtitle "${escapeAppleScript(options.subtitle)}"` : "";

  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"${subtitle} sound name "${sound}"`;

  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Map notification types to macOS notification titles and sounds.
 */
function nativeNotifyMeta(type: NotificationType): { title: string; sound: string } {
  switch (type) {
    case "task-complete": return { title: "8gent - Task Complete", sound: "Glass" };
    case "task-failed": return { title: "8gent - Task Failed", sound: "Basso" };
    case "approval-needed": return { title: "8gent - Approval Needed", sound: "Ping" };
    case "error": return { title: "8gent - Error", sound: "Sosumi" };
    default: return { title: "8gent", sound: "Glass" };
  }
}

// ── Email Notifications (Resend API) ────────────────────────────

const EMAIL_NOTIFY_TYPES = new Set<NotificationType>([
  "task-complete",
  "task-failed",
  "approval-needed",
  "daily-summary",
  "error",
]);

interface EmailConfig {
  apiKey: string;
  from: string;
  to: string;
}

/**
 * Send an email notification via Resend API.
 * Config comes from env: RESEND_API_KEY, EIGHT_EMAIL_FROM, EIGHT_EMAIL_TO
 */
export async function sendEmailNotification(
  config: EmailConfig,
  subject: string,
  body: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [config.to],
        subject,
        text: body,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function emailSubject(type: NotificationType): string {
  switch (type) {
    case "task-complete": return "8gent - Task Complete";
    case "task-failed": return "8gent - Task Failed";
    case "approval-needed": return "8gent - Approval Needed";
    case "daily-summary": return "8gent - Daily Summary";
    case "error": return "8gent - Error";
    default: return "8gent Notification";
  }
}

function getEmailConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EIGHT_EMAIL_FROM || "8gent <notifications@8gent.dev>";
  const to = process.env.EIGHT_EMAIL_TO;
  if (!apiKey || !to) return null;
  return { apiKey, from, to };
}

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
    // Telegram
    const chatId = this.getChatForType(type);
    await this.send(chatId, message);

    // macOS native notification for key events
    if (MACOS_NOTIFY_TYPES.has(type)) {
      const meta = nativeNotifyMeta(type);
      const short = message.length > 200 ? message.slice(0, 197) + "..." : message;
      sendNativeNotification(meta.title, short, { sound: meta.sound }).catch(() => {});
    }

    // Email (if configured)
    if (EMAIL_NOTIFY_TYPES.has(type)) {
      const emailCfg = getEmailConfig();
      if (emailCfg) {
        sendEmailNotification(emailCfg, emailSubject(type), message).catch(() => {});
      }
    }
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
