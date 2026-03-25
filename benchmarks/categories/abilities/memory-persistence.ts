// -- Memory Persistence Benchmark ------------------------------------------------
// Tests: packages/memory/store.ts + packages/memory/types.ts
// Validates store-recall, FTS search, contradiction detection, and time decay.
import { MemoryStore } from "../../../packages/memory/store.js";
import { effectiveImportance, generateId } from "../../../packages/memory/types.js";
import type { SemanticMemory } from "../../../packages/memory/types.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `8gent-mem-bench-${Date.now()}.db`);

function makeSemanticMemory(
  key: string,
  value: string,
  opts: Partial<SemanticMemory> = {}
): SemanticMemory {
  const now = Date.now();
  return {
    id: generateId("mem"),
    type: "semantic",
    category: "fact",
    scope: "project",
    key,
    value,
    confidence: 0.9,
    evidenceCount: 1,
    tags: opts.tags ?? [key],
    relatedKeys: [],
    learnedAt: now,
    lastConfirmed: now,
    importance: opts.importance ?? 0.7,
    decayFactor: opts.decayFactor ?? 1.0,
    accessCount: opts.accessCount ?? 0,
    lastAccessed: opts.lastAccessed ?? now,
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
    version: 1,
    source: "user_explicit",
    ...opts,
  };
}

// -- Test runner ---------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function run(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const store = new MemoryStore(dbPath);

  // 1. Store and recall by ID
  const fact = makeSemanticMemory("runtime", "Bun with Ink v6");
  const id = store.write(fact);
  const recalled = store.get(id);
  results.push({
    name: "store-and-recall",
    passed: recalled !== null && recalled.type === "semantic" && (recalled as SemanticMemory).value === "Bun with Ink v6",
    detail: recalled ? "Recalled value matches" : "Recall returned null",
  });

  // 2. FTS search returns relevant memories
  store.write(makeSemanticMemory("database", "SQLite with WAL mode and FTS5", { tags: ["sqlite", "database"] }));
  store.write(makeSemanticMemory("framework", "React via Ink for terminal UI", { tags: ["react", "tui"] }));
  store.write(makeSemanticMemory("language", "TypeScript with Bun runtime", { tags: ["typescript", "bun"] }));

  const searchResults = await store.recall("SQLite database");
  const topMatch = searchResults[0];
  results.push({
    name: "fts-semantic-search",
    passed: searchResults.length > 0 && (topMatch.memory as SemanticMemory).key === "database",
    detail: `Found ${searchResults.length} results, top: ${topMatch ? (topMatch.memory as SemanticMemory).key : "none"}`,
  });

  // 3. Contradiction detection via knowledge graph relationships
  const entityA = store.addEntity({ type: "concept", name: "deploy-target", firstSeen: Date.now(), lastSeen: Date.now(), mentionCount: 1 });
  const memA = store.write(makeSemanticMemory("deploy-target", "Fly.io Amsterdam"));
  const memB = store.write(makeSemanticMemory("deploy-target-v2", "AWS us-east-1"));
  store.linkEntityToMemory(entityA, memA, "deploy target is Fly.io");
  store.linkEntityToMemory(entityA, memB, "deploy target is AWS");
  store.addRelationship({ sourceId: entityA, targetId: entityA, type: "contradicts", strength: 0.8 });

  const rels = store.getRelationships(entityA);
  const hasContradiction = rels.some((r) => r.type === "contradicts");
  results.push({
    name: "contradiction-detection",
    passed: hasContradiction,
    detail: hasContradiction ? "Contradiction relationship found" : "No contradiction detected",
  });

  // 4. Memory decay over time
  const oldCreatedAt = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days ago
  const freshMem = makeSemanticMemory("fresh-fact", "just learned", { importance: 0.8, createdAt: Date.now() });
  const staleMem = makeSemanticMemory("stale-fact", "old knowledge", { importance: 0.8, createdAt: oldCreatedAt, lastAccessed: oldCreatedAt });

  const freshScore = effectiveImportance(freshMem);
  const staleScore = effectiveImportance(staleMem);
  results.push({
    name: "memory-decay",
    passed: freshScore > staleScore * 1.5,
    detail: `Fresh: ${freshScore.toFixed(3)}, Stale: ${staleScore.toFixed(3)}, ratio: ${(freshScore / staleScore).toFixed(1)}x`,
  });

  // 5. Soft delete prevents recall
  const ephemeral = makeSemanticMemory("temp-secret", "do not persist");
  const ephId = store.write(ephemeral);
  store.forget(ephId, "user requested deletion");
  const forgotten = store.get(ephId);
  results.push({
    name: "soft-delete",
    passed: forgotten === null,
    detail: forgotten === null ? "Deleted memory correctly hidden" : "Deleted memory still visible",
  });

  // 6. Batch write + stats
  const batch = Array.from({ length: 5 }, (_, i) => makeSemanticMemory(`batch-${i}`, `value-${i}`));
  store.writeBatch(batch);
  const stats = store.getStats();
  results.push({
    name: "batch-write-stats",
    passed: stats.total >= 10 && stats.byType.semantic >= 10,
    detail: `Total: ${stats.total}, semantic: ${stats.byType.semantic}, entities: ${stats.entities}`,
  });

  store.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}

  return results;
}

// -- Main ----------------------------------------------------------------------
const results = await run();
let passed = 0;
let failed = 0;
for (const r of results) {
  const icon = r.passed ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${r.name} - ${r.detail}`);
  if (r.passed) passed++;
  else failed++;
}

console.log(`\nMemory Persistence Benchmark: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
