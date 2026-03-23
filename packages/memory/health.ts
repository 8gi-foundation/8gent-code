/**
 * Memory Health Introspection - composite health score for the memory store.
 */

import { Database } from "bun:sqlite";

export interface MemoryHealth {
  totalCount: number;
  staleCount: number;
  avgStrength: number;
  oldestMemory: string;
  newestMemory: string;
  lastConsolidation: string | null;
  healthScore: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function memoryHealth(db: Database): MemoryHealth {
  const total = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL").get() as any)?.count ?? 0;
  const stale = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL AND importance < 0.3").get() as any)?.count ?? 0;
  const avgStrength = (db.prepare("SELECT AVG(importance) as avg FROM memories WHERE deleted_at IS NULL").get() as any)?.avg ?? 0;
  const oldest = (db.prepare("SELECT MIN(created_at) as ts FROM memories WHERE deleted_at IS NULL").get() as any)?.ts;
  const newest = (db.prepare("SELECT MAX(created_at) as ts FROM memories WHERE deleted_at IS NULL").get() as any)?.ts;

  // Check consolidation_log table if it exists
  let lastConsolidation: string | null = null;
  try {
    const row = db.prepare("SELECT MAX(created_at) as ts FROM consolidation_log").get() as any;
    if (row?.ts) lastConsolidation = new Date(row.ts).toISOString();
  } catch {
    // Table may not exist yet
  }

  let score = 100;
  if (total > 0) {
    score -= Math.floor((stale / total) * 30);
    if (lastConsolidation && Date.now() - new Date(lastConsolidation).getTime() > SEVEN_DAYS_MS) {
      score -= 20;
    } else if (!lastConsolidation) {
      score -= 20;
    }
    if (total > 1000) score -= 10;
  }

  return {
    totalCount: total,
    staleCount: stale,
    avgStrength: Math.round(avgStrength * 100) / 100,
    oldestMemory: oldest ? new Date(oldest).toISOString() : "never",
    newestMemory: newest ? new Date(newest).toISOString() : "never",
    lastConsolidation,
    healthScore: Math.max(0, Math.min(100, score)),
  };
}
