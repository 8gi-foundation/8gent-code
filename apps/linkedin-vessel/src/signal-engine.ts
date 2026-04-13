/**
 * Signal Engine - Intent signal enrichment from public sources.
 *
 * Pulls buying signals from job boards, Crunchbase, LinkedIn activity.
 * This is GojiberryAI's "secret sauce" - it's just public APIs + scraping.
 */

import type { Lead, Signal } from "./types";
import { randomId } from "./utils";

// ── Job Board Signals (Greenhouse, Lever, Workable - all public) ──────

async function getJobSignals(company: string): Promise<Signal[]> {
  const signals: Signal[] = [];

  // Greenhouse public API - no auth needed
  try {
    const slug = company.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
    const res = await fetch(`https://api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (res.ok) {
      const data = await res.json();
      const jobs: any[] = data?.jobs || [];

      // AI/ML hiring = strong signal
      const aiJobs = jobs.filter(j =>
        /machine learning|ml engineer|ai engineer|llm|data scientist/i.test(j.title)
      );
      if (aiJobs.length > 0) {
        signals.push({
          type: "job_posting",
          summary: `${company} is hiring ${aiJobs.length} AI/ML role(s): ${aiJobs[0].title}`,
          strength: 0.9,
          source: `greenhouse.io/${slug}`,
          detectedAt: new Date().toISOString(),
        });
      }

      // General scaling signal
      if (jobs.length > 10) {
        signals.push({
          type: "job_posting",
          summary: `${company} has ${jobs.length} open roles - actively scaling`,
          strength: 0.6,
          source: `greenhouse.io/${slug}`,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  } catch {
    // Company not on Greenhouse, skip
  }

  return signals;
}

// ── Crunchbase Funding Signals ────────────────────────────────────────

async function getFundingSignals(company: string): Promise<Signal[]> {
  // Crunchbase basic search - free tier, rate limited
  const apiKey = process.env.CRUNCHBASE_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(
      `https://api.crunchbase.com/api/v4/entities/organizations/${encodeURIComponent(company.toLowerCase().replace(/\s+/g, "-"))}?field_ids=short_description,funding_total,last_funding_at,last_funding_type,num_funding_rounds&user_key=${apiKey}`
    );
    if (!res.ok) return [];

    const data = await res.json();
    const props = data?.properties;
    if (!props?.last_funding_at) return [];

    // Recent funding (last 6 months) = strong signal
    const fundedAt = new Date(props.last_funding_at);
    const monthsAgo = (Date.now() - fundedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (monthsAgo < 6) {
      return [{
        type: "funding",
        summary: `${company} raised ${props.last_funding_type} ${monthsAgo < 1 ? "this month" : `${Math.round(monthsAgo)} months ago`}`,
        strength: monthsAgo < 1 ? 0.95 : monthsAgo < 3 ? 0.85 : 0.7,
        source: "crunchbase.com",
        detectedAt: new Date().toISOString(),
      }];
    }
  } catch {
    // Company not found or rate limited
  }

  return [];
}

// ── LinkedIn Recent Posts Signal ──────────────────────────────────────

import { getRecentActivity } from "./linkedin-api";

async function getPostSignals(publicId: string, name: string): Promise<Signal[]> {
  try {
    const posts = await getRecentActivity(publicId);
    if (posts.length === 0) return [];

    // Check if they posted about problems we solve
    const problemKeywords = [
      "ai tools", "productivity", "context switch", "workflow", "automation",
      "engineering velocity", "developer experience", "devtools"
    ];

    const matched = posts.find(p =>
      problemKeywords.some(kw => p.toLowerCase().includes(kw))
    );

    if (matched) {
      return [{
        type: "post_engagement",
        summary: `${name} recently posted about: "${matched.slice(0, 100)}"`,
        strength: 0.75,
        source: "linkedin.com",
        detectedAt: new Date().toISOString(),
      }];
    }
  } catch {
    // API error, skip
  }

  return [];
}

// ── Main Enrichment ───────────────────────────────────────────────────

export async function enrichLead(lead: Lead): Promise<Lead> {
  const signals: Signal[] = [];

  const [jobSigs, fundingSigs, postSigs] = await Promise.allSettled([
    getJobSignals(lead.company),
    getFundingSignals(lead.company),
    getPostSignals(lead.publicId, lead.name),
  ]);

  if (jobSigs.status === "fulfilled") signals.push(...jobSigs.value);
  if (fundingSigs.status === "fulfilled") signals.push(...fundingSigs.value);
  if (postSigs.status === "fulfilled") signals.push(...postSigs.value);

  // Sort by signal strength
  signals.sort((a, b) => b.strength - a.strength);

  return { ...lead, signals, enrichedAt: new Date().toISOString() };
}

export function pickBestSignal(lead: Lead): Signal | null {
  if (lead.signals.length === 0) return null;
  return lead.signals[0];  // already sorted by strength
}

export function buildSignalHook(lead: Lead): string {
  const signal = pickBestSignal(lead);
  if (!signal) return "";

  switch (signal.type) {
    case "job_posting":
      return `I saw ${lead.company} is ${signal.summary.toLowerCase()}`;
    case "funding":
      return `Congrats on ${lead.company}'s recent ${signal.summary.split(" ").slice(-2).join(" ")}`;
    case "post_engagement":
      return `Your recent post about ${signal.summary.split(":")[1]?.trim().slice(0, 60) || "AI workflows"} hit close to home`;
    default:
      return signal.summary;
  }
}
