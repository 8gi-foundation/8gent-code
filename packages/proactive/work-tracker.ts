/**
 * 8gent - Work Tracker
 *
 * Persists opportunities to ~/.8gent/opportunities.json.
 * Tracks state transitions: found -> evaluated -> accepted -> in-progress -> delivered | rejected
 *
 * Inspired by: CashClaw (autonomous work lifecycle management)
 */

import { join } from "path";
import type { Opportunity } from "./opportunity-scanner.ts";

const DATA_DIR = join(process.env.HOME || "~", ".8gent");
const STORE_PATH = join(DATA_DIR, "opportunities.json");

// ============================================
// Storage helpers
// ============================================

async function readStore(): Promise<Opportunity[]> {
  try {
    const text = await Bun.file(STORE_PATH).text();
    return JSON.parse(text) as Opportunity[];
  } catch {
    return [];
  }
}

async function writeStore(opps: Opportunity[]): Promise<void> {
  // Ensure ~/.8gent exists
  try {
    await Bun.write(STORE_PATH, JSON.stringify(opps, null, 2));
  } catch {
    // mkdir -p equivalent via shell — Bun doesn't expose mkdir yet without node:fs
    const { mkdir } = await import("node:fs/promises");
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(STORE_PATH, JSON.stringify(opps, null, 2));
  }
}

// ============================================
// Public API
// ============================================

/**
 * Persist a new opportunity (or update existing by id).
 */
export async function trackOpportunity(opp: Opportunity): Promise<void> {
  const existing = await readStore();
  const idx = existing.findIndex((o) => o.id === opp.id);
  if (idx >= 0) {
    existing[idx] = opp;
  } else {
    existing.push(opp);
  }
  await writeStore(existing);
}

/**
 * Persist multiple opportunities at once (upsert by id).
 */
export async function trackAll(opps: Opportunity[]): Promise<void> {
  const existing = await readStore();
  for (const opp of opps) {
    const idx = existing.findIndex((o) => o.id === opp.id);
    if (idx >= 0) {
      existing[idx] = opp;
    } else {
      existing.push(opp);
    }
  }
  await writeStore(existing);
}

/**
 * Get all opportunities, optionally filtered by status.
 */
export async function getOpportunities(status?: Opportunity["status"]): Promise<Opportunity[]> {
  const all = await readStore();
  if (!status) return all;
  return all.filter((o) => o.status === status);
}

/**
 * Advance an opportunity to the next status.
 * Returns the updated opportunity, or null if not found.
 */
export async function advanceStatus(
  id: string,
  newStatus: Opportunity["status"]
): Promise<Opportunity | null> {
  const existing = await readStore();
  const idx = existing.findIndex((o) => o.id === id);
  if (idx < 0) return null;

  existing[idx] = { ...existing[idx], status: newStatus };
  await writeStore(existing);
  return existing[idx];
}

/**
 * Remove all opportunities with the given status (e.g. clear rejected).
 */
export async function pruneByStatus(status: Opportunity["status"]): Promise<number> {
  const existing = await readStore();
  const before = existing.length;
  const filtered = existing.filter((o) => o.status !== status);
  await writeStore(filtered);
  return before - filtered.length;
}

/**
 * Return a simple summary of the current pipeline.
 */
export async function getPipelineSummary(): Promise<Record<Opportunity["status"], number>> {
  const all = await readStore();
  const summary: Record<string, number> = {
    found: 0,
    evaluated: 0,
    accepted: 0,
    "in-progress": 0,
    delivered: 0,
    rejected: 0,
  };
  for (const opp of all) {
    summary[opp.status] = (summary[opp.status] || 0) + 1;
  }
  return summary as Record<Opportunity["status"], number>;
}

/**
 * Get the top N opportunities by matchScore with status "evaluated".
 */
export async function getTopOpportunities(n = 5): Promise<Opportunity[]> {
  const evaluated = await getOpportunities("evaluated");
  return evaluated.sort((a, b) => b.matchScore - a.matchScore).slice(0, n);
}
