/**
 * @8gent/telegram-bot — Persistent Bot Memory
 *
 * Stores conversations, repo intelligence, learnings, and arbitrary key-value data.
 * Persists to ~/.8gent/bot-memory.json with atomic writes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type {
  BotMemoryData,
  ConversationEntry,
  RepoEntry,
  Learning,
} from "./types";

const DEFAULT_MEMORY_PATH = join(homedir(), ".8gent", "bot-memory.json");
const MAX_CONVERSATIONS_PER_CHAT = 200;
const MAX_LEARNINGS = 500;

function emptyMemory(): BotMemoryData {
  return {
    store: {},
    conversations: {},
    repos: [],
    learnings: [],
  };
}

export class BotMemory {
  private memoryPath: string;
  private data: BotMemoryData;

  constructor(memoryPath?: string) {
    this.memoryPath = memoryPath ?? DEFAULT_MEMORY_PATH;
    this.data = this.load();
  }

  // ── Persistence ─────────────────────────────────────

  private load(): BotMemoryData {
    try {
      if (existsSync(this.memoryPath)) {
        const raw = readFileSync(this.memoryPath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          store: parsed.store ?? {},
          conversations: parsed.conversations ?? {},
          repos: parsed.repos ?? [],
          learnings: parsed.learnings ?? [],
        };
      }
    } catch (err) {
      console.error(`[bot-memory] Failed to load: ${err}`);
    }
    return emptyMemory();
  }

  private save(): void {
    try {
      const dir = dirname(this.memoryPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.memoryPath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error(`[bot-memory] Failed to save: ${err}`);
    }
  }

  // ── Key-Value Store ─────────────────────────────────

  /**
   * Store a value by key. Persists immediately.
   */
  store_val(key: string, value: any): void {
    this.data.store[key] = value;
    this.save();
  }

  /**
   * Recall a stored value by key.
   */
  recall(key: string): any {
    return this.data.store[key] ?? null;
  }

  /**
   * Delete a stored value.
   */
  forget(key: string): void {
    delete this.data.store[key];
    this.save();
  }

  /**
   * List all stored keys.
   */
  keys(): string[] {
    return Object.keys(this.data.store);
  }

  // ── Conversation Tracking ───────────────────────────

  /**
   * Log a conversation exchange.
   */
  logConversation(
    chatId: string,
    userMessage: string,
    botResponse: string
  ): void {
    if (!this.data.conversations[chatId]) {
      this.data.conversations[chatId] = [];
    }

    const entry: ConversationEntry = {
      timestamp: new Date().toISOString(),
      chatId,
      userMessage,
      botResponse,
    };

    this.data.conversations[chatId].push(entry);

    // Trim old conversations
    if (this.data.conversations[chatId].length > MAX_CONVERSATIONS_PER_CHAT) {
      this.data.conversations[chatId] = this.data.conversations[chatId].slice(
        -MAX_CONVERSATIONS_PER_CHAT
      );
    }

    this.save();
  }

  /**
   * Get recent conversation history for a chat.
   */
  getConversationHistory(
    chatId: string,
    limit: number = 20
  ): ConversationEntry[] {
    const history = this.data.conversations[chatId] ?? [];
    return history.slice(-limit);
  }

  /**
   * Get total conversation count across all chats.
   */
  getConversationCount(): number {
    return Object.values(this.data.conversations).reduce(
      (sum, entries) => sum + entries.length,
      0
    );
  }

  // ── Repo Tracking ───────────────────────────────────

  /**
   * Add a repo to the knowledge base.
   */
  addRepo(repo: Omit<RepoEntry, "addedAt">): void {
    // Avoid duplicates by name
    const existing = this.data.repos.findIndex((r) => r.name === repo.name);
    const entry: RepoEntry = {
      ...repo,
      addedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      this.data.repos[existing] = entry;
    } else {
      this.data.repos.push(entry);
    }

    this.save();
  }

  /**
   * Get repos, optionally filtered by min score or category.
   */
  getRepos(filter?: {
    minScore?: number;
    category?: string;
  }): RepoEntry[] {
    let repos = [...this.data.repos];

    if (filter?.minScore !== undefined) {
      repos = repos.filter((r) => (r.score ?? 0) >= filter.minScore!);
    }
    if (filter?.category) {
      repos = repos.filter(
        (r) => r.category?.toLowerCase() === filter.category!.toLowerCase()
      );
    }

    return repos.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  /**
   * Remove a repo by name.
   */
  removeRepo(name: string): boolean {
    const idx = this.data.repos.findIndex((r) => r.name === name);
    if (idx >= 0) {
      this.data.repos.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  // ── Learnings ───────────────────────────────────────

  /**
   * Add a learning/insight discovered by the bot.
   */
  addLearning(learning: string, source: string): void {
    const entry: Learning = {
      id: randomUUID().slice(0, 8),
      learning,
      source,
      timestamp: new Date().toISOString(),
    };

    this.data.learnings.push(entry);

    // Trim old learnings
    if (this.data.learnings.length > MAX_LEARNINGS) {
      this.data.learnings = this.data.learnings.slice(-MAX_LEARNINGS);
    }

    this.save();
  }

  /**
   * Get learnings, optionally filtered by a search query (simple substring match on learning text).
   */
  getLearnings(query?: string): Learning[] {
    if (!query) {
      return [...this.data.learnings];
    }

    const q = query.toLowerCase();
    return this.data.learnings.filter(
      (l) =>
        l.learning.toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q)
    );
  }

  /**
   * Get a summary of memory contents.
   */
  getSummary(): {
    storeKeys: number;
    conversations: number;
    repos: number;
    learnings: number;
  } {
    return {
      storeKeys: Object.keys(this.data.store).length,
      conversations: this.getConversationCount(),
      repos: this.data.repos.length,
      learnings: this.data.learnings.length,
    };
  }
}
