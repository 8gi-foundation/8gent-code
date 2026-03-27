/**
 * TaskRouter - Deterministic message routing for the board plane.
 *
 * Receives Discord MESSAGE_CREATE events, checks mention targeting,
 * rate limits, strips mentions, builds context, and creates tasks
 * in the durable queue. No LLM calls - pure routing logic.
 */

import type { BoardMember, DiscordMessage } from "./types";
import type { TaskQueue } from "./task-queue";

export class RateLimiter {
  private lastResponse: Map<string, number> = new Map(); // channelId -> timestamp
  private limitMs: number;

  constructor(limitMs: number = 10_000) {
    this.limitMs = limitMs;
  }

  check(channelId: string): boolean {
    const last = this.lastResponse.get(channelId) ?? 0;
    if (Date.now() - last < this.limitMs) return false;
    this.lastResponse.set(channelId, Date.now());
    return true;
  }

  reset(channelId: string): void {
    this.lastResponse.delete(channelId);
  }
}

export class TaskRouter {
  private members: Map<string, BoardMember>;
  private botIds: Map<string, string>; // botUserId -> memberCode
  private taskQueue: TaskQueue;
  private rateLimiter: RateLimiter;

  constructor(
    members: Map<string, BoardMember>,
    taskQueue: TaskQueue,
    rateLimiter: RateLimiter,
  ) {
    this.members = members;
    this.taskQueue = taskQueue;
    this.rateLimiter = rateLimiter;
    // Build reverse lookup: botUserId -> memberCode
    this.botIds = new Map();
  }

  /** Register a bot's Discord user ID after gateway READY */
  registerBotId(memberCode: string, botUserId: string): void {
    this.botIds.set(botUserId, memberCode);
    console.log(`[router] registered ${memberCode} -> ${botUserId}`);
  }

  /** Called by DiscordGateway on MESSAGE_CREATE */
  handleMessage(botCode: string, message: DiscordMessage): void {
    // 1. Skip bot authors
    if (message.author.bot) return;

    // 2. Check if this specific bot was mentioned
    const member = this.members.get(botCode);
    if (!member) return;

    const isMentioned = message.mentions.some((m) => m.id === member.discordBotId);
    const isDM = !message.guildId;
    if (!isMentioned && !isDM) return;

    // 3. Rate limit per channel
    if (!this.rateLimiter.check(message.channelId)) {
      console.log(`[router] rate limited: ${botCode} in ${message.channelId}`);
      return;
    }

    // 4. Strip mentions and clean content
    const content = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!content) return;

    // 5. Build conversation context from recent completed tasks in this channel
    const recentTasks = this.taskQueue.getRecentTasks(message.channelId, 5);
    const contextMessages = recentTasks
      .reverse()
      .flatMap((t) => [
        { role: "user", content: t.content },
        { role: "assistant", content: t.response ?? "" },
      ])
      .filter((m) => m.content);

    // 6. Create durable task
    const taskId = this.taskQueue.createTask({
      memberCode: botCode,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorName: message.author.username,
      content,
      systemPrompt: member.systemPrompt,
      contextMessages,
      createdAt: Date.now(),
    });

    console.log(`[router] task ${taskId} created for ${botCode} from ${message.author.username}: ${content.slice(0, 60)}`);
  }

  /** Check if a Discord user ID belongs to one of our bots */
  isOwnBot(userId: string): boolean {
    return this.botIds.has(userId);
  }
}
