/**
 * DataCurator - Extract and curate training pairs from agent session logs.
 *
 * Reads successful agent sessions from .8gent/kernel/training/pairs.jsonl
 * (collected by PersonalCollector), filters for quality, and exports
 * ShareGPT-format JSONL suitable for fine-tuning.
 *
 * CLI: bun run packages/kernel/data-curator.ts --output training-pairs.jsonl
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { TrainingPair } from "./personal-collector";

// -- ShareGPT format types --------------------------------------------------

export interface ShareGPTMessage {
  from: "human" | "gpt";
  value: string;
}

export interface ShareGPTConversation {
  conversations: ShareGPTMessage[];
  source: string;
  score: number;
  model: string;
  session_id: string;
  collected_at: number;
}

export interface CurationStats {
  totalRead: number;
  accepted: number;
  filtered: number;
  totalPromptTokens: number;
  totalResponseTokens: number;
  estimatedCostUsd: number;
}

// -- Quality filters ---------------------------------------------------------

const MIN_PROMPT_LENGTH = 10;
const MIN_RESPONSE_LENGTH = 100;
const MIN_SCORE = 0.75;
const ERROR_PATTERNS = [
  /error:/i,
  /exception:/i,
  /stack trace/i,
  /ENOENT/,
  /EACCES/,
  /undefined is not/i,
  /cannot read propert/i,
  /fatal:/i,
];

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function isLowQuality(pair: TrainingPair): boolean {
  if (pair.prompt.length < MIN_PROMPT_LENGTH) return true;
  if (pair.response.length < MIN_RESPONSE_LENGTH) return true;
  if (pair.score < MIN_SCORE) return true;
  if (pair.userCorrected) return true;
  if (!pair.toolCallsSucceeded) return true;

  // Check for error patterns in the response
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(pair.response)) return true;
  }

  return false;
}

function toShareGPT(pair: TrainingPair): ShareGPTConversation {
  return {
    conversations: [
      { from: "human", value: pair.prompt },
      { from: "gpt", value: pair.response },
    ],
    source: "8gent-sessions",
    score: pair.score,
    model: pair.model,
    session_id: pair.sessionId,
    collected_at: pair.collectedAt,
  };
}

// -- Core curator ------------------------------------------------------------

export class DataCurator {
  private projectRoot: string;
  private pairsPath: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
    this.pairsPath = resolve(projectRoot, ".8gent", "kernel", "training", "pairs.jsonl");
  }

  /**
   * Read all raw training pairs from the PersonalCollector JSONL.
   */
  private readRawPairs(): TrainingPair[] {
    if (!existsSync(this.pairsPath)) {
      console.error(`No training pairs found at ${this.pairsPath}`);
      console.error("Run agent sessions with PersonalCollector enabled first.");
      return [];
    }

    return readFileSync(this.pairsPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TrainingPair;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as TrainingPair[];
  }

  /**
   * Curate pairs: filter for quality, convert to ShareGPT, write JSONL.
   * Returns curation stats.
   */
  curate(outputPath: string): CurationStats {
    const raw = this.readRawPairs();
    const stats: CurationStats = {
      totalRead: raw.length,
      accepted: 0,
      filtered: 0,
      totalPromptTokens: 0,
      totalResponseTokens: 0,
      estimatedCostUsd: 0,
    };

    if (raw.length === 0) return stats;

    const lines: string[] = [];

    for (const pair of raw) {
      if (isLowQuality(pair)) {
        stats.filtered++;
        continue;
      }

      const sharegpt = toShareGPT(pair);
      lines.push(JSON.stringify(sharegpt));

      stats.accepted++;
      stats.totalPromptTokens += estimateTokens(pair.prompt);
      stats.totalResponseTokens += estimateTokens(pair.response);
    }

    const outFile = resolve(this.projectRoot, outputPath);
    writeFileSync(outFile, lines.join("\n") + "\n");

    // Cost estimate: ~$8/M training tokens (OpenAI ft pricing ballpark)
    const totalTokens = stats.totalPromptTokens + stats.totalResponseTokens;
    stats.estimatedCostUsd = (totalTokens / 1_000_000) * 8;

    return stats;
  }
}

// -- CLI entrypoint ----------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const output = outputIdx !== -1 && args[outputIdx + 1]
    ? args[outputIdx + 1]
    : "training-pairs.jsonl";

  const curator = new DataCurator();
  const stats = curator.curate(output);

  console.log("\n--- Data Curation Report ---");
  console.log(`Pairs read:       ${stats.totalRead}`);
  console.log(`Accepted:         ${stats.accepted}`);
  console.log(`Filtered:         ${stats.filtered}`);
  console.log(`Prompt tokens:    ${stats.totalPromptTokens.toLocaleString()}`);
  console.log(`Response tokens:  ${stats.totalResponseTokens.toLocaleString()}`);
  console.log(`Total tokens:     ${(stats.totalPromptTokens + stats.totalResponseTokens).toLocaleString()}`);
  console.log(`Est. fine-tune:   $${stats.estimatedCostUsd.toFixed(2)}`);
  console.log(`Output:           ${resolve(process.cwd(), output)}`);
}
