/**
 * 8gent - Capability Matcher
 *
 * Evaluates whether 8gent can handle a given opportunity.
 * Simple label/keyword matching — no LLM call needed for this first pass.
 *
 * Inspired by: CashClaw (autonomous work capability evaluation)
 */

import type { Opportunity } from "./opportunity-scanner.ts";

export interface MatchResult {
  matchScore: number;   // 0-1
  canDo: boolean;
  reason: string;
  suggestedApproach?: string;
}

// 8gent's known strengths mapped to keywords
const CAPABILITY_MAP: Record<string, string[]> = {
  typescript: ["typescript", "ts", "tsx", "type-check", "types"],
  javascript: ["javascript", "js", "jsx", "node", "nodejs", "bun"],
  react: ["react", "reactjs", "jsx", "tsx", "component", "hook", "next.js", "nextjs"],
  cli: ["cli", "tui", "terminal", "command-line", "shell", "bash", "ink"],
  api: ["api", "rest", "graphql", "endpoint", "backend", "server", "http", "fetch"],
  testing: ["test", "tests", "testing", "jest", "vitest", "bun:test", "unit", "e2e"],
  docs: ["docs", "documentation", "readme", "typo", "markdown", "md"],
  refactor: ["refactor", "cleanup", "clean up", "reorganize", "restructure", "lint"],
  tooling: ["build", "bundler", "config", "setup", "install", "package", "npm", "bun"],
  ai: ["ai", "llm", "ml", "openai", "ollama", "anthropic", "prompt", "embedding"],
  database: ["database", "db", "sql", "sqlite", "postgres", "mysql", "orm", "query"],
  git: ["git", "github", "pr", "branch", "commit", "merge", "ci", "workflow", "action"],
};

// Effort-to-difficulty score — lower effort = higher match probability
const EFFORT_SCORE: Record<Opportunity["estimatedEffort"], number> = {
  trivial: 1.0,
  small: 0.85,
  medium: 0.65,
  large: 0.35,
};

// Labels that should boost match score
const POSITIVE_LABELS = [
  "good first issue",
  "easy",
  "beginner",
  "docs",
  "documentation",
  "help wanted",
  "hacktoberfest",
  "first-timers-only",
];

// Labels that should reduce match score
const NEGATIVE_LABELS = [
  "design",
  "ux",
  "mobile",
  "ios",
  "android",
  "swift",
  "kotlin",
  "rust",
  "c++",
  "cpp",
  "embedded",
];

/**
 * Default capability set for 8gent.
 * Can be overridden per user via preferences.
 */
export const DEFAULT_CAPABILITIES: string[] = [
  "typescript",
  "javascript",
  "react",
  "cli",
  "api",
  "testing",
  "docs",
  "refactor",
  "tooling",
  "ai",
  "git",
];

/**
 * Evaluate a single opportunity against a list of capability keys.
 */
export function evaluateOpportunity(
  opp: Opportunity,
  capabilities: string[] = DEFAULT_CAPABILITIES
): MatchResult {
  const text = `${opp.title} ${opp.description} ${opp.labels.join(" ")}`.toLowerCase();

  // Count how many capability keywords appear in the issue text
  let matchedCapabilities = 0;
  let totalCapabilityWeight = 0;
  const matchedDomains: string[] = [];

  for (const cap of capabilities) {
    const keywords = CAPABILITY_MAP[cap];
    if (!keywords) continue;
    totalCapabilityWeight++;
    if (keywords.some((kw) => text.includes(kw))) {
      matchedCapabilities++;
      matchedDomains.push(cap);
    }
  }

  // Base score from capability match ratio
  const capRatio = totalCapabilityWeight > 0 ? matchedCapabilities / totalCapabilityWeight : 0;

  // Effort modifier
  const effortScore = EFFORT_SCORE[opp.estimatedEffort];

  // Label modifiers
  const labelNames = opp.labels.map((l) => l.toLowerCase());
  const positiveHits = POSITIVE_LABELS.filter((l) => labelNames.some((ln) => ln.includes(l))).length;
  const negativeHits = NEGATIVE_LABELS.filter((l) => labelNames.some((ln) => ln.includes(l))).length;

  const labelBoost = positiveHits * 0.08 - negativeHits * 0.15;

  // If zero capability match but positive labels, give a floor
  const rawScore = capRatio > 0
    ? capRatio * 0.5 + effortScore * 0.3 + labelBoost + 0.1
    : effortScore * 0.2 + labelBoost;

  const matchScore = Math.max(0, Math.min(1, rawScore));
  const canDo = matchScore >= 0.4 && negativeHits === 0;

  // Build reason string
  let reason: string;
  if (negativeHits > 0) {
    const blocked = NEGATIVE_LABELS.filter((l) => labelNames.some((ln) => ln.includes(l)));
    reason = `Out of scope — requires: ${blocked.join(", ")}`;
  } else if (matchedDomains.length > 0) {
    reason = `Matched capabilities: ${matchedDomains.join(", ")} | Effort: ${opp.estimatedEffort}`;
  } else if (opp.estimatedEffort === "trivial" || opp.estimatedEffort === "small") {
    reason = `Low complexity, likely approachable despite no direct keyword match`;
  } else {
    reason = `No strong capability match — ${opp.estimatedEffort} effort`;
  }

  const suggestedApproach =
    matchedDomains.includes("docs") || opp.estimatedEffort === "trivial"
      ? "Direct implementation — no planning needed"
      : matchedDomains.length > 0
      ? "Analyze repo, implement fix/feature, open PR"
      : undefined;

  return { matchScore, canDo, reason, suggestedApproach };
}

/**
 * Batch evaluate a list of opportunities. Mutates matchScore and status in place.
 */
export function evaluateAll(
  opportunities: Opportunity[],
  capabilities?: string[]
): Opportunity[] {
  return opportunities.map((opp) => {
    const result = evaluateOpportunity(opp, capabilities);
    return {
      ...opp,
      matchScore: result.matchScore,
      status: result.canDo ? "evaluated" : ("rejected" as Opportunity["status"]),
    };
  });
}
