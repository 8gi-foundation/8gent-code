/**
 * 8gent - Revenue Engine
 *
 * Orchestrates autonomous value generation across multiple revenue stream types.
 * Persists all stream data to ~/.8gent/revenue.json.
 *
 * Pattern from: Paperclip (goal-aligned agents, budget-tracked outcomes)
 * and Durable 2.0 (agents that bring paying customers while you sleep).
 */

import { join } from "path";

export interface RevenueStream {
  id: string;
  type: "bounty" | "freelance" | "saas" | "content" | "consulting";
  source: string;
  estimatedValue: string;
  status: "identified" | "pursuing" | "active" | "delivered" | "paid";
  description: string;
  opportunityId?: string;
  createdAt: string;
  updatedAt: string;
}

// -- Storage ----------------------------------------------------------------

const DATA_DIR = join(process.env.HOME || "~", ".8gent");
const STORE_PATH = join(DATA_DIR, "revenue.json");

async function readStore(): Promise<RevenueStream[]> {
  try {
    const text = await Bun.file(STORE_PATH).text();
    return JSON.parse(text) as RevenueStream[];
  } catch {
    return [];
  }
}

async function writeStore(streams: RevenueStream[]): Promise<void> {
  try {
    await Bun.write(STORE_PATH, JSON.stringify(streams, null, 2));
  } catch {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(STORE_PATH, JSON.stringify(streams, null, 2));
  }
}

// -- Stream identification --------------------------------------------------

const CAPABILITY_TO_STREAM: Array<{
  keywords: string[];
  type: RevenueStream["type"];
  source: string;
}> = [
  { keywords: ["bounty", "hacktoberfest", "reward", "paid issue"], type: "bounty", source: "GitHub Bounties" },
  { keywords: ["freelance", "contract", "hire", "upwork", "toptal"], type: "freelance", source: "Freelance Platforms" },
  { keywords: ["api", "saas", "subscription", "plugin", "extension"], type: "saas", source: "SaaS Products" },
  { keywords: ["docs", "tutorial", "blog", "writeup", "guide"], type: "content", source: "Content Creation" },
  { keywords: ["consult", "audit", "review", "advise", "assess"], type: "consulting", source: "Consulting" },
];

/**
 * Identify potential revenue streams based on 8gent capabilities.
 * Cross-references capabilities with known opportunity types.
 */
export async function identifyRevenueStreams(capabilities: string[]): Promise<RevenueStream[]> {
  const now = new Date().toISOString();
  const streams: RevenueStream[] = [];
  const text = capabilities.join(" ").toLowerCase();

  for (const mapping of CAPABILITY_TO_STREAM) {
    const matched = mapping.keywords.some((kw) => text.includes(kw));
    const relevance = matched ? "high" : "potential";
    streams.push({
      id: `stream-${mapping.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: mapping.type,
      source: mapping.source,
      estimatedValue: estimateStreamValue(mapping.type),
      status: "identified",
      description: buildStreamDescription(mapping.type, relevance),
      createdAt: now,
      updatedAt: now,
    });
  }

  return streams;
}

function estimateStreamValue(type: RevenueStream["type"]): string {
  const ranges: Record<RevenueStream["type"], string> = {
    bounty: "$50-$500 per issue",
    freelance: "$500-$5000 per project",
    saas: "$20-$200/mo recurring",
    content: "$50-$300 per piece",
    consulting: "$150-$500/hr",
  };
  return ranges[type];
}

function buildStreamDescription(type: RevenueStream["type"], relevance: string): string {
  const descriptions: Record<RevenueStream["type"], string> = {
    bounty: "Resolve open GitHub issues with attached bounties or Bountysource rewards",
    freelance: "Take on short-term coding contracts via discovered job boards or direct outreach",
    saas: "Package a solved capability as a productized API or plugin with recurring billing",
    content: "Write technical tutorials, API docs, or case studies for developer platforms",
    consulting: "Offer async code review, architecture audits, or debugging sessions",
  };
  return `[${relevance}] ${descriptions[type]}`;
}

// -- Public API -------------------------------------------------------------

/**
 * Persist a revenue stream (upsert by id).
 */
export async function trackRevenue(stream: RevenueStream): Promise<void> {
  const existing = await readStore();
  const idx = existing.findIndex((s) => s.id === stream.id);
  const updated = { ...stream, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    existing[idx] = updated;
  } else {
    existing.push(updated);
  }
  await writeStore(existing);
}

/**
 * Advance a stream to a new status.
 */
export async function advanceStreamStatus(
  id: string,
  newStatus: RevenueStream["status"]
): Promise<RevenueStream | null> {
  const existing = await readStore();
  const idx = existing.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  existing[idx] = { ...existing[idx], status: newStatus, updatedAt: new Date().toISOString() };
  await writeStore(existing);
  return existing[idx];
}

/**
 * Generate a human-readable revenue report.
 */
export async function getRevenueReport(): Promise<{
  streams: RevenueStream[];
  totalIdentified: string;
  totalDelivered: string;
}> {
  const streams = await readStore();
  const identified = streams.filter((s) => s.status !== "paid").length;
  const delivered = streams.filter((s) => s.status === "delivered" || s.status === "paid").length;

  return {
    streams,
    totalIdentified: `${identified} active streams across ${new Set(streams.map((s) => s.type)).size} categories`,
    totalDelivered: `${delivered} stream(s) delivered`,
  };
}
