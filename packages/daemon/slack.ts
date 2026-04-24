/**
 * Slack Notification Adapter
 *
 * Sends notifications to Slack via incoming webhook or Bot API.
 * Supports:
 * - Simple text messages
 * - Threaded replies
 * - Rich block messages (status cards)
 *
 * Config via env:
 *   SLACK_WEBHOOK_URL  - Incoming webhook URL
 *   SLACK_BOT_TOKEN    - Bot token (for threaded replies + channels)
 *   SLACK_CHANNEL_ID   - Default channel for bot messages
 */

import type { NotificationType } from "./notifications";

// ── Types ───────────────────────────────────────────────────────

export interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text: string; emoji?: boolean }>;
  fields?: Array<{ type: string; text: string }>;
}

// ── Config ──────────────────────────────────────────────────────

export function getSlackConfig(): SlackConfig | null {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!webhookUrl && !botToken) return null;
  return { webhookUrl, botToken, channelId };
}

// ── Status Card Formatting ──────────────────────────────────────

function statusEmoji(type: NotificationType): string {
  switch (type) {
    case "task-complete": return ":white_check_mark:";
    case "task-failed": return ":x:";
    case "task-created": return ":sparkles:";
    case "task-progress": return ":hourglass_flowing_sand:";
    case "approval-needed": return ":raised_hand:";
    case "daily-summary": return ":bar_chart:";
    case "error": return ":rotating_light:";
    default: return ":robot_face:";
  }
}

function formatBlocks(type: NotificationType, message: string): SlackBlock[] {
  const emoji = statusEmoji(type);
  const title = type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Truncate message for Slack block limit (3000 chars)
  const truncated = message.length > 2800
    ? message.slice(0, 2797) + "..."
    : message;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} 8gent - ${title}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncated },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Vessel:* ${process.env.HOSTNAME || "local"} | *Time:* ${new Date().toISOString()}` },
      ],
    },
  ];
}

// ── Webhook Sender ──────────────────────────────────────────────

async function sendViaWebhook(
  webhookUrl: string,
  type: NotificationType,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: formatBlocks(type, message),
        text: message.slice(0, 200), // Fallback for notifications
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Bot API Sender ──────────────────────────────────────────────

async function sendViaBot(
  token: string,
  channel: string,
  type: NotificationType,
  message: string,
  threadTs?: string,
): Promise<{ ok: boolean; ts?: string }> {
  try {
    const body: Record<string, unknown> = {
      channel,
      blocks: formatBlocks(type, message),
      text: message.slice(0, 200),
    };
    if (threadTs) body.thread_ts = threadTs;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as { ok: boolean; ts?: string; error?: string };
    return { ok: data.ok, ts: data.ts };
  } catch {
    return { ok: false };
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Send a Slack notification. Uses webhook if available, falls back to bot API.
 */
export async function sendSlackNotification(
  config: SlackConfig,
  type: NotificationType,
  message: string,
  threadTs?: string,
): Promise<{ ok: boolean; threadTs?: string }> {
  // Prefer webhook for simple messages (no auth setup needed)
  if (config.webhookUrl && !threadTs) {
    const ok = await sendViaWebhook(config.webhookUrl, type, message);
    return { ok };
  }

  // Bot API for threaded replies or when no webhook
  if (config.botToken && config.channelId) {
    const result = await sendViaBot(
      config.botToken,
      config.channelId,
      type,
      message,
      threadTs,
    );
    return { ok: result.ok, threadTs: result.ts };
  }

  return { ok: false };
}

// ── Notification Types to Slack ─────────────────────────────────

const SLACK_NOTIFY_TYPES = new Set<NotificationType>([
  "task-complete",
  "task-failed",
  "approval-needed",
  "daily-summary",
  "error",
]);

export function shouldNotifySlack(type: NotificationType): boolean {
  return SLACK_NOTIFY_TYPES.has(type);
}
