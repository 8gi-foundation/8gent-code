/**
 * 8gent - Content Packaging Rules Engine
 *
 * Data-backed rules for content hook/title optimization.
 * Abstracted from analysis of 173 Alex Hormozi YouTube videos over 24 months.
 *
 * Key findings encoded:
 * - 0% of top 20% performers used question titles
 * - 270x gap between concrete ("$100k") vs abstract ("monetize")
 * - 66% of top performers led with proof (3.5x over curiosity)
 * - 91% of top performers used 1 of 9 known formulas
 * - 405:1 gap caused by packaging alone
 * - Packaging = 60% of performance, quality = 15%
 */

// ============================================
// Types
// ============================================

export type PackagingRuleName =
  | "STATEMENTS_OVER_QUESTIONS"
  | "CONCRETE_OVER_ABSTRACT"
  | "PROOF_OVER_PROMISE"
  | "PROVEN_FORMULAS"
  | "FIRST_LINE_IS_DISTRIBUTION"
  | "PACKAGING_WEIGHT"
  | "SPECIFICITY_KILLS_VAGUENESS";

export type FormulaName =
  | "if-i-wanted-to"
  | "heres-how-to"
  | "i-did-x-found-y"
  | "x-things-learned"
  | "number-timeframe-outcome";

export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export interface PackagingRule {
  name: PackagingRuleName;
  weight: number;
  description: string;
  dataPoint: string;
}

export interface RuleScore {
  rule: PackagingRuleName;
  score: number;
  passed: boolean;
  feedback: string;
}

export interface PackagingScore {
  overall: number;
  breakdown: RuleScore[];
  grade: Grade;
  topIssue: string | null;
}

export interface AuditReport {
  hooks: Array<{ original: string; score: PackagingScore; alternatives: string[] }>;
  summary: { average: number; best: string; worst: string; topPattern: string };
}

// ============================================
// Rules
// ============================================

const RULES: PackagingRule[] = [
  { name: "STATEMENTS_OVER_QUESTIONS", weight: 2, description: "Statements outperform questions universally", dataPoint: "0% of top 20% used questions" },
  { name: "CONCRETE_OVER_ABSTRACT", weight: 2, description: "Concrete specifics beat abstract language", dataPoint: "270x gap between $100k vs monetize" },
  { name: "PROOF_OVER_PROMISE", weight: 2, description: "Lead with proof, not promise", dataPoint: "66% top performers led with proof - 3.5x over curiosity" },
  { name: "PROVEN_FORMULAS", weight: 1, description: "Use one of the 9 proven formula structures", dataPoint: "91% of top performers used a known formula" },
  { name: "FIRST_LINE_IS_DISTRIBUTION", weight: 2, description: "First 8 words must hook", dataPoint: "405:1 gap from packaging alone" },
  { name: "PACKAGING_WEIGHT", weight: 1, description: "Packaging is 60% of performance", dataPoint: "Quality only accounts for 15%" },
  { name: "SPECIFICITY_KILLS_VAGUENESS", weight: 2, description: "Specific outcomes beat vague goals", dataPoint: "1,000 followers beats grow your audience" },
];

const ABSTRACT_WORDS = ["grow", "scale", "monetize", "optimize", "leverage", "transform", "elevate", "empower", "unlock", "maximize", "accelerate"];
const VAGUE_GOALS = ["grow your audience", "build your brand", "increase engagement", "make more money", "get more views"];
const QUESTION_STARTERS = /^(how|what|why|when|where|who|do|does|can|should|would|could|will|is|are)\b/i;
const PROOF_PATTERNS = /\b(i studied|i analyzed|i tested|data shows|after \d+|(\d+) out of (\d+))\b/i;
const PROMISE_PATTERNS = /\b(i'll teach|i'm going to show|learn how to|discover|secrets? to)\b/i;
const CONCRETE_PATTERN = /(\$[\d,]+k?|\d+%|\d+[\s-]+(days?|months?|hours?|years?|weeks?)|\d{2,}[\s,]*(followers?|subscribers?|views?|customers?))/i;
const NUMBER_PATTERN = /\d+/;

const FORMULAS: Record<FormulaName, { template: string; example: string; avgPerformance: number }> = {
  "if-i-wanted-to": {
    template: "if i wanted to {topic} in 2026, i'd do this.",
    example: "if i wanted to get my first 1,000 followers on Threads in 2026, i'd do this.",
    avgPerformance: 28060,
  },
  "heres-how-to": {
    template: "here's how to {topic} (step by step).",
    example: "here's how to close your first $10k client (step by step).",
    avgPerformance: 9200,
  },
  "i-did-x-found-y": {
    template: "I studied how people {topic} and found 7 patterns.",
    example: "I studied how people get their first 1,000 followers on Threads and found 7 patterns.",
    avgPerformance: 8100,
  },
  "x-things-learned": {
    template: "5 things I learned from {topic}.",
    example: "5 things I learned from building a $1M newsletter.",
    avgPerformance: 7400,
  },
  "number-timeframe-outcome": {
    template: "30 days to {topic} - the exact playbook.",
    example: "30 days to 10,000 subscribers - the exact playbook.",
    avgPerformance: 6800,
  },
};

const FORMULA_DETECTORS: Array<{ name: FormulaName; pattern: RegExp }> = [
  { name: "if-i-wanted-to", pattern: /^if i wanted to\b/i },
  { name: "heres-how-to", pattern: /^here'?s how to\b/i },
  { name: "i-did-x-found-y", pattern: /^i (studied|analyzed|tested|spent)\b/i },
  { name: "x-things-learned", pattern: /^\d+ things i learned/i },
  { name: "number-timeframe-outcome", pattern: /^\d+\s+(days?|months?|weeks?)\s+to\b/i },
];

// ============================================
// Scoring helpers
// ============================================

function gradeFromScore(score: number): Grade {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function evaluateRule(text: string, rule: PackagingRule): RuleScore {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const first8 = words.slice(0, 8).join(" ");

  switch (rule.name) {
    case "STATEMENTS_OVER_QUESTIONS": {
      const isQuestion = lower.endsWith("?") || QUESTION_STARTERS.test(lower);
      return { rule: rule.name, score: isQuestion ? -20 : 10, passed: !isQuestion, feedback: isQuestion ? "Questions kill reach - 0% of top performers used them. Rewrite as a statement." : "Good - statement format." };
    }
    case "CONCRETE_OVER_ABSTRACT": {
      const hasConcrete = CONCRETE_PATTERN.test(text) || NUMBER_PATTERN.test(text);
      const hasAbstract = ABSTRACT_WORDS.some(w => lower.includes(w));
      if (hasConcrete && !hasAbstract) return { rule: rule.name, score: 15, passed: true, feedback: "Strong - concrete specifics present." };
      if (hasConcrete && hasAbstract) return { rule: rule.name, score: 5, passed: true, feedback: "Has concrete details but also abstract words. Cut the fluff." };
      if (hasAbstract) return { rule: rule.name, score: -15, passed: false, feedback: `Abstract language detected. Replace with specific numbers or outcomes. Flagged: ${ABSTRACT_WORDS.filter(w => lower.includes(w)).join(", ")}` };
      return { rule: rule.name, score: 0, passed: false, feedback: "No concrete specifics found. Add numbers, dollar amounts, or timeframes." };
    }
    case "PROOF_OVER_PROMISE": {
      const hasProof = PROOF_PATTERNS.test(text);
      const hasPromise = PROMISE_PATTERNS.test(text);
      if (hasProof) return { rule: rule.name, score: 15, passed: true, feedback: "Proof-first hook - 3.5x better than curiosity." };
      if (hasPromise) return { rule: rule.name, score: -10, passed: false, feedback: "Promise-based hook. Lead with what you found/tested instead." };
      return { rule: rule.name, score: 0, passed: false, feedback: "Neither proof nor promise detected. Consider leading with evidence." };
    }
    case "PROVEN_FORMULAS": {
      const match = FORMULA_DETECTORS.find(f => f.pattern.test(lower));
      if (match) return { rule: rule.name, score: 10, passed: true, feedback: `Matches proven formula: ${match.name} (avg ${FORMULAS[match.name].avgPerformance.toLocaleString()} views/day).` };
      return { rule: rule.name, score: 0, passed: false, feedback: "Doesn't match a known high-performing formula. Consider restructuring." };
    }
    case "FIRST_LINE_IS_DISTRIBUTION": {
      const hasHookElement = NUMBER_PATTERN.test(first8) || CONCRETE_PATTERN.test(first8);
      const isGeneric = first8.length > 0 && !hasHookElement && words.length > 2;
      if (hasHookElement) return { rule: rule.name, score: 10, passed: true, feedback: "First 8 words contain a hook element." };
      if (isGeneric) return { rule: rule.name, score: -5, passed: false, feedback: "First 8 words are generic. Front-load a number or specific outcome." };
      return { rule: rule.name, score: 0, passed: false, feedback: "Weak opening. Put the most compelling element in the first 8 words." };
    }
    case "PACKAGING_WEIGHT": {
      // Meta-rule: not directly scorable, acts as a weight multiplier.
      // Give a small bonus if other packaging signals are strong (detected via concrete + formula).
      const hasConcrete = CONCRETE_PATTERN.test(text) || NUMBER_PATTERN.test(text);
      const hasFormula = FORMULA_DETECTORS.some(f => f.pattern.test(lower));
      if (hasConcrete && hasFormula) return { rule: rule.name, score: 5, passed: true, feedback: "Packaging fundamentals are solid." };
      return { rule: rule.name, score: 0, passed: true, feedback: "Packaging = 60% of performance. Invest more time here than on content quality." };
    }
    case "SPECIFICITY_KILLS_VAGUENESS": {
      const hasVague = VAGUE_GOALS.some(v => lower.includes(v));
      const hasSpecific = CONCRETE_PATTERN.test(text);
      if (hasVague) return { rule: rule.name, score: -10, passed: false, feedback: `Vague goal detected. Replace with a specific measurable outcome.` };
      if (hasSpecific) return { rule: rule.name, score: 10, passed: true, feedback: "Specific outcome stated." };
      return { rule: rule.name, score: 0, passed: false, feedback: "Add a specific, measurable outcome to replace any vague goals." };
    }
  }
}

// ============================================
// Public API
// ============================================

/** Rate a hook/title against the 7 packaging rules. Returns 0-100. */
export function scoreHook(text: string): PackagingScore {
  const breakdown = RULES.map(rule => evaluateRule(text, rule));
  const totalWeight = RULES.reduce((sum, r) => sum + r.weight, 0);
  const weightedSum = breakdown.reduce((sum, rs, i) => sum + rs.score * RULES[i].weight, 0);
  // Normalize: max possible weighted score is ~80, min is ~-80. Map to 0-100.
  const maxPossible = 65;
  const raw = 50 + (weightedSum / totalWeight) * (50 / 15);
  const overall = Math.max(0, Math.min(100, Math.round(raw)));
  const worst = breakdown.filter(r => !r.passed).sort((a, b) => a.score - b.score)[0];

  return {
    overall,
    breakdown,
    grade: gradeFromScore(overall),
    topIssue: worst ? worst.feedback : null,
  };
}

/** Identify which rules are violated with specific, actionable feedback. */
export function diagnoseHook(text: string): RuleScore[] {
  return RULES.map(rule => evaluateRule(text, rule)).filter(rs => !rs.passed);
}

/** Apply a proven formula to a topic string. Simple interpolation, no AI needed. */
export function applyFormula(topic: string, formula: FormulaName): string {
  const f = FORMULAS[formula];
  if (!f) return topic;
  return f.template.replace("{topic}", topic);
}

/** Generate rule-compliant alternatives for a hook. Applies all formulas to the topic. */
export function repackage(hook: string, topic?: string): string[] {
  const t = topic || hook;
  const formulaNames = Object.keys(FORMULAS) as FormulaName[];
  return formulaNames.map(name => applyFormula(t, name));
}

/** Score multiple hooks, return sorted by score with diagnoses and alternatives. */
export function auditBatch(hooks: string[]): AuditReport {
  const scored = hooks.map(original => {
    const score = scoreHook(original);
    const alternatives = repackage(original);
    return { original, score, alternatives };
  });

  scored.sort((a, b) => b.score.overall - a.score.overall);

  const totals = scored.map(s => s.score.overall);
  const average = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
  const best = scored[0]?.original || "";
  const worst = scored[scored.length - 1]?.original || "";

  // Find most common violated rule
  const violations: Record<string, number> = {};
  for (const s of scored) {
    for (const rs of s.score.breakdown) {
      if (!rs.passed) violations[rs.rule] = (violations[rs.rule] || 0) + 1;
    }
  }
  const topPattern = Object.entries(violations).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

  return { hooks: scored, summary: { average, best, worst, topPattern } };
}
