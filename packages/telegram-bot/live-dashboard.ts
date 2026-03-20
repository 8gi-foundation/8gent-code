/**
 * @8gent/telegram-bot — Live Dashboard
 *
 * A live-updating scoreboard message that gets edited in real-time
 * during competition runs. Sends one message and keeps editing it
 * with fresh data as rounds complete.
 */

import type { DashboardData } from "./types";
import type { TelegramBot } from "./index";
import { progressBar, sparkline, formatDuration } from "./formatters";

const MIN_UPDATE_INTERVAL_MS = 3000; // Telegram rate limit protection

export class LiveDashboard {
  private messageId: number | null = null;
  private chatId: string;
  private lastUpdateTime: number = 0;
  private history: number[] = []; // score history for sparkline
  private startTime: number = Date.now();

  constructor(chatId?: string) {
    this.chatId = chatId ?? "";
  }

  /**
   * Start the live dashboard by sending the initial message.
   * Returns the message ID for future edits.
   */
  async start(bot: TelegramBot): Promise<number> {
    this.chatId = bot.getChatId();
    this.startTime = Date.now();
    this.history = [];

    const initialText = this.formatDashboard({
      roundNumber: 0,
      totalRounds: 0,
      timestamp: new Date().toISOString(),
      eightAvg: 0,
      claudeAvg: 0,
      trend: "stable",
      progressPercent: 0,
      estimatedCompletion: "calculating...",
    });

    // Send initial message and capture the message_id
    const result = await bot.api("sendMessage", {
      chat_id: this.chatId,
      text: initialText,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    this.messageId = result.message_id;
    return this.messageId;
  }

  /**
   * Update the dashboard with new data by editing the existing message.
   */
  async update(bot: TelegramBot, data: DashboardData): Promise<void> {
    if (!this.messageId) {
      // Dashboard not started yet — start it
      await this.start(bot);
    }

    // Rate limit protection
    const now = Date.now();
    if (now - this.lastUpdateTime < MIN_UPDATE_INTERVAL_MS) {
      return;
    }
    this.lastUpdateTime = now;

    // Track score history
    this.history.push(data.eightAvg);

    const text = this.formatDashboard(data);

    try {
      await bot.api("editMessageText", {
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      // "message is not modified" is expected if data hasn't changed
      if (!err.message?.includes("message is not modified")) {
        console.error(`[live-dashboard] Edit failed: ${err.message}`);
      }
    }
  }

  /**
   * Finalize the dashboard with a completion message.
   */
  async finish(bot: TelegramBot, finalData: DashboardData): Promise<void> {
    if (!this.messageId) return;

    const elapsed = Date.now() - this.startTime;
    const trendLine = this.history.length >= 3 ? sparkline(this.history) : "";

    const lines: string[] = [];
    lines.push("```");
    lines.push("┌─────────────────────────┐");
    lines.push("│  COMPETITION COMPLETE   │");
    lines.push("├─────────────────────────┤");
    lines.push(`│ Rounds: ${String(finalData.totalRounds).padStart(3)}             │`);
    lines.push(`│ Duration: ${formatDuration(elapsed).padEnd(13)}│`);
    lines.push("├─────────────────────────┤");
    lines.push(`│ 8gent: ${finalData.eightAvg.toFixed(1).padStart(5)} avg        │`);
    lines.push(`│ Claude: ${finalData.claudeAvg.toFixed(1).padStart(5)} avg       │`);

    const delta = finalData.eightAvg - finalData.claudeAvg;
    const verdict =
      delta > 5
        ? "8GENT WINS"
        : delta > 0
        ? "8gent leads"
        : delta > -5
        ? "NECK & NECK"
        : "Claude leads";
    lines.push("├─────────────────────────┤");
    lines.push(`│ ${verdict.padEnd(23)} │`);

    if (trendLine) {
      lines.push(`│ Trend: ${trendLine.padEnd(16)}│`);
    }

    lines.push("├─────────────────────────┤");
    lines.push(`│ ${progressBar(100, 100)} 100%  │`);
    lines.push("└─────────────────────────┘");
    lines.push("```");

    const text = lines.join("\n");

    try {
      await bot.api("editMessageText", {
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      if (!err.message?.includes("message is not modified")) {
        console.error(`[live-dashboard] Final edit failed: ${err.message}`);
      }
    }

    this.messageId = null;
  }

  /**
   * Format the live dashboard text.
   */
  private formatDashboard(data: DashboardData): string {
    const now = new Date(data.timestamp || Date.now());
    const timeStr = now.toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
    });

    const trendIcon =
      data.trend === "improving"
        ? "improving"
        : data.trend === "declining"
        ? "declining"
        : "stable";

    const trendArrow =
      data.trend === "improving"
        ? "+"
        : data.trend === "declining"
        ? "-"
        : "=";

    const bar = progressBar(data.progressPercent, 100);
    const pct = `${Math.round(data.progressPercent)}%`;

    const trendLine =
      this.history.length >= 3 ? sparkline(this.history) : "---";

    const deltaStr =
      data.recentDelta !== undefined
        ? data.recentDelta > 0
          ? `+${data.recentDelta.toFixed(1)}`
          : data.recentDelta.toFixed(1)
        : "---";

    const lines: string[] = [];
    lines.push("```");
    lines.push("┌─────────────────────────┐");
    lines.push(`│  LIVE COMPETITION       │`);
    lines.push(
      `│ Round ${String(data.roundNumber).padStart(2)}/${String(data.totalRounds).padStart(2)} | ${timeStr.padEnd(8)} │`
    );
    lines.push("├─────────────────────────┤");
    lines.push(`│ 8gent:  ${data.eightAvg.toFixed(1).padStart(5)} avg       │`);
    lines.push(`│ Claude: ${data.claudeAvg.toFixed(1).padStart(5)} avg       │`);
    lines.push(`│ Delta:  ${deltaStr.padStart(5)}   (${trendArrow})     │`);
    lines.push("├─────────────────────────┤");
    lines.push(`│ Trend: ${trendLine.padEnd(17)}│`);
    lines.push("├─────────────────────────┤");
    lines.push(`│ ${bar} ${pct.padStart(4)}  │`);

    if (data.estimatedCompletion) {
      lines.push(
        `│ Est: ${data.estimatedCompletion.padEnd(19)}│`
      );
    }

    if (data.topScore) {
      lines.push("├─────────────────────────┤");
      lines.push(
        `│ Best: ${data.topScore.name.slice(0, 10).padEnd(10)} ${String(Math.round(data.topScore.score)).padStart(3)} │`
      );
    }

    lines.push("└─────────────────────────┘");
    lines.push("```");

    return lines.join("\n");
  }

  /**
   * Check if the dashboard is currently active.
   */
  isActive(): boolean {
    return this.messageId !== null;
  }

  /**
   * Get the current message ID.
   */
  getMessageId(): number | null {
    return this.messageId;
  }

  /**
   * Get the score history for external use.
   */
  getHistory(): number[] {
    return [...this.history];
  }
}
