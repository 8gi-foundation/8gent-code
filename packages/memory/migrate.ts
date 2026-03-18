/**
 * Memory v1 -> v2 Migration
 *
 * Reads existing .8gent/memory/*.jsonl files and imports them into the
 * SQLite v2 store with proper type classification and embeddings.
 *
 * Classification uses heuristics (no LLM dependency for migration).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type Memory,
  type MemoryType,
  type MemoryScope,
  type SemanticCategory,
  type CoreCategory,
  type V1MemoryEntry,
  generateId,
} from "./types.js";
import { MemoryStore } from "./store.js";
import { type EmbeddingProvider } from "./embeddings.js";

// ── Migration Result ──────────────────────────────────────────────────

export interface MigrationResult {
  projectMigrated: number;
  globalMigrated: number;
  skipped: number;
  errors: string[];
  duration: number;
}

// ── Main Migration Function ───────────────────────────────────────────

/**
 * Migrate v1 JSONL memory files to v2 SQLite.
 * Idempotent — skips entries whose IDs already exist.
 */
export async function migrateV1ToV2(
  workingDirectory: string,
  projectStore: MemoryStore,
  globalStore: MemoryStore,
  embeddingProvider?: EmbeddingProvider
): Promise<MigrationResult> {
  const startTime = Date.now();
  const result: MigrationResult = {
    projectMigrated: 0,
    globalMigrated: 0,
    skipped: 0,
    errors: [],
    duration: 0,
  };

  // Read v1 JSONL files
  const projectJsonl = path.join(workingDirectory, ".8gent", "memory", "project.jsonl");
  const globalJsonl = path.join(os.homedir(), ".8gent", "memory", "global.jsonl");

  const projectEntries = readJsonlSafe(projectJsonl);
  const globalEntries = readJsonlSafe(globalJsonl);

  // Migrate project entries
  for (const entry of projectEntries) {
    try {
      const existing = projectStore.get(entry.id, true);
      if (existing) {
        result.skipped++;
        continue;
      }

      const memory = classifyAndConvert(entry, "project");
      projectStore.write(memory);
      result.projectMigrated++;
    } catch (error) {
      result.errors.push(`Project entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Migrate global entries
  for (const entry of globalEntries) {
    try {
      const existing = globalStore.get(entry.id, true);
      if (existing) {
        result.skipped++;
        continue;
      }

      const memory = classifyAndConvert(entry, "global");
      globalStore.write(memory);
      result.globalMigrated++;
    } catch (error) {
      result.errors.push(`Global entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

// ── Classification Heuristics ─────────────────────────────────────────

/**
 * Classify a v1 memory entry into the v2 type taxonomy using keyword heuristics.
 * No LLM dependency — pure pattern matching on the fact text.
 */
function classifyAndConvert(entry: V1MemoryEntry, scope: MemoryScope): Memory {
  const fact = entry.fact.toLowerCase();
  const now = Date.now();
  const createdAt = new Date(entry.createdAt).getTime() || now;

  const base = {
    id: entry.id,
    scope,
    importance: 0.5,
    decayFactor: 1.0,
    accessCount: 0,
    lastAccessed: createdAt,
    createdAt,
    updatedAt: now,
    version: 1,
    source: "import" as const,
    sourceId: entry.source || undefined,
  };

  // Check for procedural patterns (steps, commands, workflows)
  if (isProceduralFact(fact)) {
    return {
      ...base,
      type: "procedural",
      name: extractProceduralName(entry.fact),
      description: entry.fact,
      steps: extractSteps(entry.fact),
      preconditions: [],
      successRate: 0.5,
      executionCount: 0,
      tags: entry.tags,
    };
  }

  // Check for core project knowledge
  if (isCoreFact(fact, entry.tags)) {
    const category = classifyCoreCategory(fact, entry.tags);
    return {
      ...base,
      type: "core",
      category,
      key: generateKeyFromFact(entry.fact),
      title: entry.fact.slice(0, 80),
      content: entry.fact,
      confidence: 0.7,
      evidenceCount: 1,
      tags: entry.tags,
    };
  }

  // Check for episodic patterns (events, actions taken)
  if (isEpisodicFact(fact)) {
    return {
      ...base,
      type: "episodic",
      content: entry.fact,
      context: "",
      tags: entry.tags,
      entities: [],
      occurredAt: createdAt,
    };
  }

  // Default to semantic (facts, preferences, knowledge)
  const category = classifySemanticCategory(fact, entry.tags);
  return {
    ...base,
    type: "semantic",
    category,
    key: generateKeyFromFact(entry.fact),
    value: entry.fact,
    confidence: 0.6,
    evidenceCount: 1,
    tags: entry.tags,
    relatedKeys: [],
    learnedAt: createdAt,
    lastConfirmed: createdAt,
  };
}

// ── Pattern Detection ─────────────────────────────────────────────────

function isProceduralFact(fact: string): boolean {
  const patterns = [
    /to deploy/i,
    /to build/i,
    /to run/i,
    /to test/i,
    /step \d/i,
    /first,?\s/i,
    /then,?\s/i,
    /run\s+`/i,
    /execute/i,
    /workflow/i,
    /procedure/i,
    /how to/i,
  ];
  return patterns.some((p) => p.test(fact));
}

function isCoreFact(fact: string, tags: string[]): boolean {
  const corePatterns = [
    /architecture/i,
    /tech stack/i,
    /project name/i,
    /project description/i,
    /project uses/i,
    /monorepo/i,
    /runtime/i,
    /framework/i,
    /convention/i,
    /rule:/i,
    /package\.json/i,
    /tsconfig/i,
    /depends on/i,
    /dependency/i,
    /infrastructure/i,
    /deployment/i,
    /ci\/cd/i,
  ];
  const coreTagPatterns = ["config", "architecture", "infrastructure", "convention"];

  return (
    corePatterns.some((p) => p.test(fact)) ||
    tags.some((t) => coreTagPatterns.includes(t.toLowerCase()))
  );
}

function isEpisodicFact(fact: string): boolean {
  const patterns = [
    /^fixed\s/i,
    /^added\s/i,
    /^removed\s/i,
    /^updated\s/i,
    /^deployed\s/i,
    /^merged\s/i,
    /^created\s/i,
    /^resolved\s/i,
    /tests? (are|is|were) passing/i,
    /bug\s/i,
    /error\s/i,
    /issue\s/i,
    /broke\s/i,
    /failed\s/i,
  ];
  return patterns.some((p) => p.test(fact));
}

function classifyCoreCategory(fact: string, tags: string[]): CoreCategory {
  if (/architect|design|pattern|monorepo|structure/i.test(fact)) return "architecture";
  if (/depend|package|version|npm|bun/i.test(fact) || tags.includes("config")) return "dependency";
  if (/config|setting|env|tsconfig/i.test(fact)) return "configuration";
  if (/convention|rule|standard|lint|format/i.test(fact)) return "convention";
  if (/readme|doc|changelog/i.test(fact)) return "documentation";
  if (/deploy|ci|cd|docker|kubernetes|infra/i.test(fact)) return "infrastructure";
  return "documentation";
}

function classifySemanticCategory(fact: string, _tags: string[]): SemanticCategory {
  if (/prefer|like|want|always use|should use/i.test(fact)) return "preference";
  if (/pattern|usually|tends to|common/i.test(fact)) return "pattern";
  if (/can |knows? how|api |endpoint|method/i.test(fact)) return "skill";
  if (/team|person|member|author|owner/i.test(fact)) return "relationship";
  if (/must not|never|cannot|limit|restrict/i.test(fact)) return "constraint";
  if (/goal|target|milestone|objective/i.test(fact)) return "goal";
  if (/convention|style|standard/i.test(fact)) return "convention";
  return "fact";
}

// ── Extraction Helpers ────────────────────────────────────────────────

function generateKeyFromFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4)
    .join("-");
}

function extractProceduralName(fact: string): string {
  // Try to extract a concise name from the fact
  const match = fact.match(/(?:to|how to)\s+(.{5,40}?)(?:\.|,|:|$)/i);
  if (match) return match[1].trim().toLowerCase().replace(/\s+/g, "-");
  return generateKeyFromFact(fact);
}

function extractSteps(fact: string): Array<{ order: number; action: string }> {
  // Simple step extraction — split on sentence boundaries
  const sentences = fact
    .split(/[.;]\s*/)
    .filter((s) => s.trim().length > 5)
    .slice(0, 10);

  return sentences.map((s, i) => ({
    order: i + 1,
    action: s.trim(),
  }));
}

// ── JSONL Reader ──────────────────────────────────────────────────────

function readJsonlSafe(filePath: string): V1MemoryEntry[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const entries: V1MemoryEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as V1MemoryEntry);
      } catch {
        // Skip corrupted lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}
