/**
 * 8gent Code - Cross-Platform Notification Dispatcher
 *
 * Supports macOS (osascript), Linux (notify-send), terminal bell fallback,
 * and Telegram bot. Auto-detects platform at runtime.
 */

import { spawnSync } from "child_process";

export interface NotifyOptions {
  /** Notification title (defaults to "8gent") */
  title?: string;
  /** Optional subtitle shown below the title on macOS */
  subtitle?: string;
  /** The main message body */
  message: string;
  /**
   * Which channels to use. Defaults to ["native", "terminal"].
   * "native"   - osascript on macOS, notify-send on Linux
   * "terminal" - ASCII bell (BEL character) via process.stdout
   * "telegram" - sends via Telegram bot (requires env vars)
   */
  channels?: Array<"native" | "terminal" | "telegram">;
  /** Override Telegram bot token (falls back to TELEGRAM_BOT_TOKEN env var) */
  telegramToken?: string;
  /** Override Telegram chat ID (falls back to TELEGRAM_CHAT_ID env var) */
  telegramChatId?: string;
}

export interface NotifyResult {
  /** Channel name */
  channel: "native" | "terminal" | "telegram";
  /** Whether the dispatch succeeded */
  ok: boolean;
  /** Error message if it failed */
  error?: string;
}

function detectPlatform(): "macos" | "linux" | "other" {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return "other";
}

function notifyNative(
  title: string,
  subtitle: string | undefined,
  message: string
): NotifyResult {
  const platform = detectPlatform();

  try {
    if (platform === "macos") {
      const subtitlePart = subtitle
        ? ` subtitle "${subtitle.replace(/"/g, '\\"')}"`
        : "";
      const script = `display notification "${message.replace(/"/g, '\\"')}"${subtitlePart} with title "${title.replace(/"/g, '\\"')}"`;
      spawnSync("osascript", ["-e", script], { timeout: 5000 });
      return { channel: "native", ok: true };
    }

    if (platform === "linux") {
      const args = [title, message, "-t", "5000"];
      if (subtitle) args.push("-h", `string:x-canonical-subtitle:${subtitle}`);
      const result = spawnSync("notify-send", args, { timeout: 5000 });
      if (result.status !== 0) {
        return {
          channel: "native",
          ok: false,
          error: result.stderr?.toString() || "notify-send failed",
        };
      }
      return { channel: "native", ok: true };
    }

    return {
      channel: "native",
      ok: false,
      error: `No native notification support on platform: ${process.platform}`,
    };
  } catch (err) {
    return {
      channel: "native",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function notifyTerminal(): NotifyResult {
  try {
    process.stdout.write("\x07");
    return { channel: "terminal", ok: true };
  } catch (err) {
    return {
      channel: "terminal",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function notifyTelegram(
  title: string,
  message: string,
  token?: string,
  chatId?: string
): Promise<NotifyResult> {
  const botToken = token ?? process.env.TELEGRAM_BOT_TOKEN;
  const chat = chatId ?? process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chat) {
    return {
      channel: "telegram",
      ok: false,
      error:
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Set env vars or pass via options.",
    };
  }

  const text = `*${title}*\n${message}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        channel: "telegram",
        ok: false,
        error: `Telegram API error: ${body}`,
      };
    }

    return { channel: "telegram", ok: true };
  } catch (err) {
    return {
      channel: "telegram",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send a cross-platform notification.
 *
 * @example
 * await notify({ message: "Build complete" });
 * await notify({
 *   title: "8gent",
 *   message: "Task finished",
 *   channels: ["native", "telegram"],
 * });
 */
export async function notify(options: NotifyOptions): Promise<NotifyResult[]> {
  const {
    title = "8gent",
    subtitle,
    message,
    channels = ["native", "terminal"],
    telegramToken,
    telegramChatId,
  } = options;

  const results: NotifyResult[] = [];

  for (const channel of channels) {
    switch (channel) {
      case "native":
        results.push(notifyNative(title, subtitle, message));
        break;
      case "terminal":
        results.push(notifyTerminal());
        break;
      case "telegram":
        results.push(
          await notifyTelegram(title, message, telegramToken, telegramChatId)
        );
        break;
    }
  }

  return results;
}
