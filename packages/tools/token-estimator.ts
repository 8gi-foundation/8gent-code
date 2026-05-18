/**
 * Token Estimator for 8gent
 *
 * Char-based heuristic token counting with per-model cost calculation
 * and context window utilisation. Zero external dependencies.
 *
 * Heuristic: 1 token ~ 4 chars for English prose / code.
 * Adjusted per content type (code is denser, whitespace-heavy is lighter).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelSpec {
  id: string;
  label: string;
  contextWindow: number;
  /** USD per 1 000 input tokens */
  inputCostPer1k: number;
  /** USD per 1 000 output tokens */
  outputCostPer1k: number;
}

export interface TokenEstimate {
  chars: number;
  tokens: number;
  /** Which heuristic was applied */
  method: "code" | "prose" | "mixed";
}

export interface CostEstimate {
  model: ModelSpec;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export interface ContextUsage {
  model: ModelSpec;
  tokens: number;
  contextWindow: number;
  usedPercent: number;
  remaining: number;
  overLimit: boolean;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/**
 * Representative models with pricing as of early 2026.
 * Prices are approximations - verify against provider docs before billing.
 */
export const MODELS: ModelSpec[] = [
  // Anthropic
  {
    id: "claude-3-5-sonnet",
    label: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  },
  {
    id: "claude-3-haiku",
    label: "Claude 3 Haiku",
    contextWindow: 200_000,
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
  },
  {
    id: "claude-opus-4",
    label: "Claude Opus 4",
    contextWindow: 200_000,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
  },
  // OpenAI
  {
    id: "gpt-4o",
    label: "GPT-4o",
    contextWindow: 128_000,
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o Mini",
    contextWindow: 128_000,
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
  },
  {
    id: "o1",
    label: "OpenAI o1",
    contextWindow: 200_000,
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.06,
  },
  // Google
  {
    id: "gemini-2-flash",
    label: "Gemini 2.0 Flash",
    contextWindow: 1_048_576,
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
  },
  {
    id: "gemini-2-pro",
    label: "Gemini 2.0 Pro",
    contextWindow: 2_000_000,
    inputCostPer1k: 0.0035,
    outputCostPer1k: 0.014,
  },
  // Meta / OpenRouter free
  {
    id: "llama-3-70b",
    label: "Llama 3 70B (OpenRouter free)",
    contextWindow: 128_000,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
  },
  // Local
  {
    id: "qwen-3.5-local",
    label: "Qwen 3.5 (Ollama local)",
    contextWindow: 32_768,
    inputCostPer1k: 0,
    outputCostPer1k: 0,
  },
];

/** Look up a model by id (case-insensitive partial match). Returns undefined if not found. */
export function findModel(query: string): ModelSpec | undefined {
  const q = query.toLowerCase();
  return MODELS.find((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Detect whether text is primarily code or prose.
 *
 * Code signals: high density of `{};()=>` chars, lines starting with
 * spaces/tabs, or common keywords appearing frequently.
 */
function detectContentType(text: string): "code" | "prose" | "mixed" {
  if (!text.length) return "prose";

  const codeChars = (text.match(/[{}()=><;|]/g) ?? []).length;
  const codeRatio = codeChars / text.length;

  const indentedLines = (text.match(/^[ \t]{2,}/gm) ?? []).length;
  const totalLines = (text.match(/\n/g) ?? []).length + 1;
  const indentRatio = indentedLines / Math.max(totalLines, 1);

  if (codeRatio > 0.06 || indentRatio > 0.4) return "code";
  if (codeRatio > 0.03 || indentRatio > 0.2) return "mixed";
  return "prose";
}

/**
 * Chars-per-token ratio by content type.
 *
 * - prose: ~4 chars/token (GPT tokeniser rule of thumb)
 * - code: ~3 chars/token (shorter identifiers, many single-char tokens)
 * - mixed: ~3.5 chars/token
 */
const CHARS_PER_TOKEN: Record<"code" | "prose" | "mixed", number> = {
  prose: 4.0,
  code: 3.0,
  mixed: 3.5,
};

/**
 * Estimate token count for a string using char-based heuristics.
 * No tokeniser library required.
 */
export function estimateTokens(text: string): TokenEstimate {
  const chars = text.length;
  if (chars === 0) return { chars: 0, tokens: 0, method: "prose" };

  const method = detectContentType(text);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN[method]);

  return { chars, tokens, method };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Estimate USD cost for a given number of input + output tokens on a model.
 *
 * @param model - ModelSpec from MODELS registry or a custom spec
 * @param inputTokens - tokens in the prompt / context
 * @param outputTokens - expected tokens in the response (default 512)
 */
export function estimateCost(
  model: ModelSpec,
  inputTokens: number,
  outputTokens = 512
): CostEstimate {
  const inputCostUsd = (inputTokens / 1000) * model.inputCostPer1k;
  const outputCostUsd = (outputTokens / 1000) * model.outputCostPer1k;

  return {
    model,
    inputTokens,
    outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

/**
 * Calculate what percentage of a model's context window the token count uses.
 */
export function contextUsage(model: ModelSpec, tokens: number): ContextUsage {
  const usedPercent = (tokens / model.contextWindow) * 100;
  return {
    model,
    tokens,
    contextWindow: model.contextWindow,
    usedPercent: Math.round(usedPercent * 100) / 100,
    remaining: Math.max(0, model.contextWindow - tokens),
    overLimit: tokens > model.contextWindow,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 6): string {
  if (n === 0) return "$0.000000";
  return `$${n.toFixed(decimals)}`;
}

function bar(pct: number, width = 30): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatEstimate(estimate: TokenEstimate): string {
  return [
    `Chars : ${thousands(estimate.chars)}`,
    `Tokens: ${thousands(estimate.tokens)}  (${estimate.method} heuristic, ~${
      CHARS_PER_TOKEN[estimate.method]
    } chars/token)`,
  ].join("\n");
}

export function formatCost(cost: CostEstimate): string {
  const free = cost.model.inputCostPer1k === 0 && cost.model.outputCostPer1k === 0;
  return [
    `Model : ${cost.model.label}`,
    `Input : ${thousands(cost.inputTokens)} tokens  ${free ? "(free)" : fmt(cost.inputCostUsd)}`,
    `Output: ${thousands(cost.outputTokens)} tokens  ${free ? "(free)" : fmt(cost.outputCostUsd)}`,
    `Total : ${free ? "(free)" : fmt(cost.totalCostUsd, 6)}`,
  ].join("\n");
}

export function formatContextUsage(usage: ContextUsage): string {
  const status = usage.overLimit ? " [OVER LIMIT]" : "";
  return [
    `Model  : ${usage.model.label}`,
    `Window : ${thousands(usage.contextWindow)} tokens`,
    `Used   : ${thousands(usage.tokens)} (${usage.usedPercent}%)${status}`,
    `Remains: ${thousands(usage.remaining)} tokens`,
    `         ${bar(Math.min(usage.usedPercent, 100))}`,
  ].join("\n");
}

/**
 * Full report across all registered models.
 */
export function fullReport(text: string, outputTokens = 512): string {
  const est = estimateTokens(text);
  const sections: string[] = [
    "=" .repeat(60),
    "8gent Token Estimator",
    "=".repeat(60),
    "",
    formatEstimate(est),
    "",
    "-".repeat(60),
    "Cost across models",
    "-".repeat(60),
    "",
  ];

  for (const model of MODELS) {
    const cost = estimateCost(model, est.tokens, outputTokens);
    const ctx = contextUsage(model, est.tokens);
    sections.push(formatCost(cost));
    sections.push(
      `Context: ${ctx.usedPercent}% of ${thousands(ctx.contextWindow)}${
        ctx.overLimit ? "  [OVER LIMIT]" : ""
      }`
    );
    sections.push(bar(Math.min(ctx.usedPercent, 100)));
    sections.push("");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  // --help
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
8gent Token Estimator - char-based heuristic token counting

Usage:
  bun run packages/tools/token-estimator.ts [options] [text]

Options:
  --file <path>        Read text from file instead of argument
  --model <id>         Show cost for a specific model only (partial match)
  --output <n>         Expected output token count (default: 512)
  --list-models        Print all registered models
  --help               Show this help

Examples:
  echo "Hello world" | bun run packages/tools/token-estimator.ts
  bun run packages/tools/token-estimator.ts --file src/agent.ts
  bun run packages/tools/token-estimator.ts --model gpt-4o "Some long text here"
  bun run packages/tools/token-estimator.ts --list-models
`);
    process.exit(0);
  }

  // --list-models
  if (args.includes("--list-models")) {
    console.log("Registered models:\n");
    for (const m of MODELS) {
      const free = m.inputCostPer1k === 0 ? " (free)" : "";
      console.log(
        `  ${m.id.padEnd(22)} ${m.label.padEnd(30)} ctx: ${thousands(m.contextWindow)}${free}`
      );
    }
    process.exit(0);
  }

  let text = "";

  // --file <path>
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const { readFileSync } = await import("node:fs");
    text = readFileSync(args[fileIdx + 1], "utf8");
  }

  // --output <n>
  let outputTokens = 512;
  const outIdx = args.indexOf("--output");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputTokens = parseInt(args[outIdx + 1], 10) || 512;
  }

  // --model <id>
  let targetModel: ModelSpec | undefined;
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    targetModel = findModel(args[modelIdx + 1]);
    if (!targetModel) {
      console.error(`Model not found: ${args[modelIdx + 1]}. Run --list-models to see options.`);
      process.exit(1);
    }
  }

  // remaining positional args = inline text
  const positional = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = args[i - 1];
    if (prev === "--file" || prev === "--model" || prev === "--output") return false;
    return true;
  });
  if (positional.length) text = positional.join(" ");

  // stdin fallback
  if (!text) {
    const stdinData = await new Response(Bun.stdin.stream()).text();
    text = stdinData.trim();
  }

  if (!text) {
    console.error("No text provided. Pass inline text, --file, or pipe via stdin.");
    process.exit(1);
  }

  const est = estimateTokens(text);

  if (targetModel) {
    console.log("\n" + formatEstimate(est));
    console.log("\n" + formatCost(estimateCost(targetModel, est.tokens, outputTokens)));
    console.log("\n" + formatContextUsage(contextUsage(targetModel, est.tokens)));
  } else {
    console.log(fullReport(text, outputTokens));
  }
}
