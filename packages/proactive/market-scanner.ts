/**
 * 8gent - Polymarket Scanner
 *
 * Fetches active prediction markets from Polymarket's public API,
 * identifies high-probability opportunities near resolution,
 * and outputs a daily brief of top opportunities.
 *
 * Designed to run as a daemon cron job via packages/proactive/.
 * Read-only - no trading execution.
 */

// -- Types ------------------------------------------------------------------

export interface MarketOpportunity {
  id: string;
  question: string;
  /** Current best price for YES outcome (0-1) */
  bestBid: number;
  /** Current best price for NO outcome (0-1) */
  bestAsk: number;
  /** 24h volume in USDC */
  volume24h: number;
  /** Total liquidity available */
  liquidity: number;
  /** Market end date */
  endDate: string;
  /** Hours until resolution */
  hoursToResolution: number;
  /** Edge score (0-100) - higher means stronger signal */
  edgeScore: number;
  /** Why this market was flagged */
  reason: string;
  /** Direct link */
  url: string;
}

export interface DailyBrief {
  generatedAt: string;
  marketsScanned: number;
  opportunities: MarketOpportunity[];
}

// -- Constants --------------------------------------------------------------

const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_BASE = "https://polymarket.com/event";

/** Minimum 24h volume to consider a market liquid enough */
const MIN_VOLUME_24H = 5_000;

/** Only look at markets resolving within this many hours */
const MAX_HOURS_TO_RESOLUTION = 168; // 7 days

/** Price thresholds for "strong signal" detection */
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const LOW_CONFIDENCE_THRESHOLD = 0.15;

// -- Gamma API types --------------------------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  endDate: string;
  volume: string;
  volume24hr: string;
  liquidity: string;
  bestBid: string;
  bestAsk: string;
  outcomePrices: string; // JSON string like "[0.95, 0.05]"
  active: boolean;
  closed: boolean;
}

// -- Fetch markets ----------------------------------------------------------

async function fetchActiveMarkets(limit = 100): Promise<GammaMarket[]> {
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "8gent-market-scanner/1.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as GammaMarket[];
}

// -- Analysis ---------------------------------------------------------------

function hoursUntil(dateStr: string): number {
  const end = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.max(0, (end - now) / (1000 * 60 * 60));
}

function parseOutcomePrices(raw: string): [number, number] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return [Number(parsed[0]), Number(parsed[1])];
    }
  } catch {
    // malformed - skip
  }
  return null;
}

function calculateEdgeScore(market: {
  yesPrice: number;
  volume24h: number;
  hoursToResolution: number;
  liquidity: number;
}): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // Strong directional signal (price near 0 or 1)
  const maxPrice = Math.max(market.yesPrice, 1 - market.yesPrice);
  if (maxPrice >= 0.95) {
    score += 35;
    reasons.push(`Strong consensus at ${(maxPrice * 100).toFixed(0)}%`);
  } else if (maxPrice >= HIGH_CONFIDENCE_THRESHOLD) {
    score += 25;
    reasons.push(`High confidence at ${(maxPrice * 100).toFixed(0)}%`);
  } else if (maxPrice >= 0.70) {
    score += 10;
    reasons.push(`Moderate signal at ${(maxPrice * 100).toFixed(0)}%`);
  }

  // Approaching resolution amplifies the signal
  if (market.hoursToResolution <= 24) {
    score += 30;
    reasons.push("Resolves within 24h");
  } else if (market.hoursToResolution <= 72) {
    score += 20;
    reasons.push("Resolves within 3 days");
  } else if (market.hoursToResolution <= MAX_HOURS_TO_RESOLUTION) {
    score += 10;
    reasons.push("Resolves within 7 days");
  }

  // Volume confirms real interest
  if (market.volume24h >= 50_000) {
    score += 20;
    reasons.push("High volume (50K+ 24h)");
  } else if (market.volume24h >= 10_000) {
    score += 10;
    reasons.push("Good volume (10K+ 24h)");
  }

  // Liquidity means you can actually enter/exit
  if (market.liquidity >= 100_000) {
    score += 15;
    reasons.push("Deep liquidity");
  } else if (market.liquidity >= 20_000) {
    score += 5;
    reasons.push("Adequate liquidity");
  }

  return {
    score: Math.min(100, score),
    reason: reasons.join(". "),
  };
}

// -- Main scanner -----------------------------------------------------------

/**
 * Scan Polymarket for high-probability opportunities.
 * Returns a daily brief with top N opportunities sorted by edge score.
 */
export async function scanMarkets(topN = 5): Promise<DailyBrief> {
  const markets = await fetchActiveMarkets(200);

  const opportunities: MarketOpportunity[] = [];

  for (const market of markets) {
    if (market.closed || !market.active) continue;

    const volume24h = Number(market.volume24hr || "0");
    if (volume24h < MIN_VOLUME_24H) continue;

    const hoursToRes = hoursUntil(market.endDate);
    if (hoursToRes <= 0 || hoursToRes > MAX_HOURS_TO_RESOLUTION) continue;

    const prices = parseOutcomePrices(market.outcomePrices);
    if (!prices) continue;

    const [yesPrice] = prices;
    const liquidity = Number(market.liquidity || "0");

    // Only flag markets with a strong directional signal
    if (yesPrice < HIGH_CONFIDENCE_THRESHOLD && yesPrice > LOW_CONFIDENCE_THRESHOLD) {
      continue;
    }

    const { score, reason } = calculateEdgeScore({
      yesPrice,
      volume24h,
      hoursToResolution: hoursToRes,
      liquidity,
    });

    if (score < 30) continue; // skip weak signals

    opportunities.push({
      id: market.id,
      question: market.question,
      bestBid: Number(market.bestBid || "0"),
      bestAsk: Number(market.bestAsk || "0"),
      volume24h,
      liquidity,
      endDate: market.endDate,
      hoursToResolution: Math.round(hoursToRes),
      edgeScore: score,
      reason,
      url: `${POLYMARKET_BASE}/${market.slug}`,
    });
  }

  // Sort by edge score descending
  opportunities.sort((a, b) => b.edgeScore - a.edgeScore);

  return {
    generatedAt: new Date().toISOString(),
    marketsScanned: markets.length,
    opportunities: opportunities.slice(0, topN),
  };
}

/**
 * Format a daily brief as a human-readable string.
 * Suitable for Telegram, TUI, or log output.
 */
export function formatBrief(brief: DailyBrief): string {
  const lines: string[] = [
    `Polymarket Daily Brief - ${new Date(brief.generatedAt).toLocaleDateString()}`,
    `Scanned ${brief.marketsScanned} active markets`,
    "",
  ];

  if (brief.opportunities.length === 0) {
    lines.push("No strong opportunities found today.");
    return lines.join("\n");
  }

  for (let i = 0; i < brief.opportunities.length; i++) {
    const opp = brief.opportunities[i];
    lines.push(`${i + 1}. ${opp.question}`);
    lines.push(`   Edge: ${opp.edgeScore}/100 | ${opp.reason}`);
    lines.push(
      `   Price: YES ${(opp.bestBid * 100).toFixed(0)}% | ` +
      `Vol: $${(opp.volume24h / 1000).toFixed(1)}K | ` +
      `Resolves: ${opp.hoursToResolution}h`
    );
    lines.push(`   ${opp.url}`);
    lines.push("");
  }

  return lines.join("\n");
}

// -- CLI entry point --------------------------------------------------------

if (import.meta.main) {
  console.log("Scanning Polymarket...\n");
  const brief = await scanMarkets(5);
  console.log(formatBrief(brief));
}
