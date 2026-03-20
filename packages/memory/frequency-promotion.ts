/**
 * Frequency Memory Promotion — Nuggets pattern
 * Facts recalled 3+ times across sessions auto-promote from ephemeral to permanent.
 *
 * Usage:
 *   const memory = new FrequencyMemory();
 *   memory.recall("src/agent.ts is the main entry point", "file_path", "session-1");
 *   // After 3+ recalls across different sessions, fact auto-promotes to PERMANENT.md
 *   const context = memory.getPermanentContext();
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

type FactType =
  | "file_path"
  | "architecture_decision"
  | "user_preference"
  | "pattern"
  | "error_fix"
  | "codebase_insight";

interface MemoryFact {
  content: string;
  type: FactType;
  recallCount: number;
  firstSeen: number;
  lastRecalled: number;
  promoted: boolean;
  sessions: string[];
}

interface FrequencyMemoryOptions {
  promotionThreshold?: number;
  basePath?: string;
}

interface MemoryStats {
  total: number;
  promoted: number;
  nearPromotion: number;
  topFacts: Array<{ content: string; type: FactType; recalls: number }>;
}

// ============================================
// Frequency Memory
// ============================================

export class FrequencyMemory {
  private factsPath: string;
  private permanentPath: string;
  private promotionThreshold: number;
  private facts: Map<string, MemoryFact> = new Map();

  constructor(options?: FrequencyMemoryOptions) {
    const base = options?.basePath ?? join(os.homedir(), ".8gent", "memory");
    mkdirSync(base, { recursive: true });
    this.factsPath = join(base, "facts.json");
    this.permanentPath = join(base, "PERMANENT.md");
    this.promotionThreshold = options?.promotionThreshold ?? 3;
    this.load();
  }

  /** Record a fact being recalled/used in the current session */
  recall(content: string, type: FactType, sessionId?: string): { promoted: boolean; recallCount: number } {
    const key = this.normalize(content);
    const existing = this.facts.get(key);

    if (existing) {
      existing.recallCount++;
      existing.lastRecalled = Date.now();
      if (sessionId && !existing.sessions.includes(sessionId)) {
        existing.sessions.push(sessionId);
      }

      // Check for promotion: needs threshold recalls AND at least 2 different sessions
      const justPromoted =
        !existing.promoted &&
        existing.recallCount >= this.promotionThreshold &&
        existing.sessions.length >= 2;

      if (justPromoted) {
        existing.promoted = true;
        this.appendToPermanent(existing);
        console.log(
          `[frequency-memory] Promoted: "${existing.content.slice(0, 60)}..." (${existing.recallCount} recalls, ${existing.sessions.length} sessions)`
        );
      }

      this.save();
      return { promoted: justPromoted, recallCount: existing.recallCount };
    }

    // New fact
    this.facts.set(key, {
      content,
      type,
      recallCount: 1,
      firstSeen: Date.now(),
      lastRecalled: Date.now(),
      promoted: false,
      sessions: sessionId ? [sessionId] : [],
    });

    this.save();
    return { promoted: false, recallCount: 1 };
  }

  /** Bulk recall multiple facts at once */
  recallMany(
    facts: Array<{ content: string; type: FactType }>,
    sessionId?: string
  ): Array<{ content: string; promoted: boolean; recallCount: number }> {
    return facts.map((f) => {
      const result = this.recall(f.content, f.type, sessionId);
      return { content: f.content, ...result };
    });
  }

  /** Get all promoted (permanent) facts */
  getPromoted(): MemoryFact[] {
    return Array.from(this.facts.values()).filter((f) => f.promoted);
  }

  /** Get facts close to promotion threshold */
  getNearPromotion(): MemoryFact[] {
    return Array.from(this.facts.values())
      .filter((f) => !f.promoted && f.recallCount >= this.promotionThreshold - 1)
      .sort((a, b) => b.recallCount - a.recallCount);
  }

  /** Generate context string for prompt injection */
  getPermanentContext(): string {
    const promoted = this.getPromoted();
    if (promoted.length === 0) return "";

    const lines = promoted
      .sort((a, b) => b.recallCount - a.recallCount)
      .map((f) => `- [${f.type}] ${f.content} (recalled ${f.recallCount}x across ${f.sessions.length} sessions)`)
      .join("\n");

    return `\n## Permanent Knowledge (auto-promoted from recall frequency)\n${lines}`;
  }

  /** Get a fact by content (normalized lookup) */
  getFact(content: string): MemoryFact | undefined {
    return this.facts.get(this.normalize(content));
  }

  /** Remove a fact (e.g. if it becomes stale) */
  forget(content: string): boolean {
    const key = this.normalize(content);
    const deleted = this.facts.delete(key);
    if (deleted) this.save();
    return deleted;
  }

  /** Decay facts that haven't been recalled recently */
  decay(maxAgeDays: number = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let decayed = 0;

    for (const [key, fact] of this.facts) {
      if (!fact.promoted && fact.lastRecalled < cutoff) {
        this.facts.delete(key);
        decayed++;
      }
    }

    if (decayed > 0) {
      this.save();
      console.log(`[frequency-memory] Decayed ${decayed} stale facts (older than ${maxAgeDays}d)`);
    }
    return decayed;
  }

  /** Get stats */
  getStats(): MemoryStats {
    const all = Array.from(this.facts.values());
    return {
      total: all.length,
      promoted: all.filter((f) => f.promoted).length,
      nearPromotion: all.filter(
        (f) => !f.promoted && f.recallCount >= this.promotionThreshold - 1
      ).length,
      topFacts: [...all]
        .sort((a, b) => b.recallCount - a.recallCount)
        .slice(0, 10)
        .map((f) => ({
          content: f.content.slice(0, 100),
          type: f.type,
          recalls: f.recallCount,
        })),
    };
  }

  // ── Private ─────────────────────────────────

  private normalize(content: string): string {
    return content.toLowerCase().trim().replace(/\s+/g, " ");
  }

  private appendToPermanent(fact: MemoryFact): void {
    const dateStr = new Date().toISOString().split("T")[0];
    const entry = `\n- **[${fact.type}]** ${fact.content} _(recalled ${fact.recallCount}x across ${fact.sessions.length} sessions, promoted ${dateStr})_\n`;

    let existing: string;
    if (existsSync(this.permanentPath)) {
      existing = readFileSync(this.permanentPath, "utf-8");
    } else {
      existing =
        "# Permanent Memory\n\nFacts auto-promoted after repeated recall across sessions.\n";
    }

    writeFileSync(this.permanentPath, existing + entry);
  }

  private load(): void {
    if (existsSync(this.factsPath)) {
      try {
        const data = JSON.parse(readFileSync(this.factsPath, "utf-8"));
        for (const [k, v] of Object.entries(data)) {
          this.facts.set(k, v as MemoryFact);
        }
      } catch {
        // Corrupted file — start fresh
        console.warn("[frequency-memory] Failed to load facts.json, starting fresh");
      }
    }
  }

  private save(): void {
    const obj: Record<string, MemoryFact> = {};
    for (const [k, v] of this.facts) obj[k] = v;
    writeFileSync(this.factsPath, JSON.stringify(obj, null, 2));
  }
}

// ============================================
// Singleton
// ============================================

let _instance: FrequencyMemory | null = null;

/** Get or create the singleton frequency memory */
export function getFrequencyMemory(options?: FrequencyMemoryOptions): FrequencyMemory {
  if (!_instance) {
    _instance = new FrequencyMemory(options);
  }
  return _instance;
}
