/**
 * Memory v2 Type Taxonomy
 *
 * Five-layer memory model adapted from FoodstackOS:
 *   Core       — project knowledge (architecture, conventions, dependencies)
 *   Episodic   — what happened (events, sessions, actions)
 *   Semantic   — what I know (facts, preferences, patterns)
 *   Procedural — how to do things (workflows, steps)
 *   Working    — active session context (TTL-based, ephemeral)
 */

// ── Enums & Unions ────────────────────────────────────────────────────

export type MemoryType = "core" | "episodic" | "semantic" | "procedural" | "working";

export type MemoryScope = "session" | "project" | "global";

export type ConsolidationLevel = "raw" | "daily" | "weekly" | "monthly" | "archetype";

export type SourceType =
  | "conversation"
  | "tool_result"
  | "user_explicit"
  | "consolidation"
  | "extraction"
  | "import"
  | "observation";

export type SemanticCategory =
  | "preference"
  | "fact"
  | "pattern"
  | "skill"
  | "relationship"
  | "constraint"
  | "goal"
  | "convention";

export type CoreCategory =
  | "architecture"
  | "dependency"
  | "configuration"
  | "convention"
  | "documentation"
  | "infrastructure";

export type EntityType =
  | "file"
  | "function"
  | "package"
  | "config"
  | "decision"
  | "person"
  | "concept"
  | "service"
  | "bug"
  | "convention";

export type RelationshipType =
  | "depends_on"
  | "defines"
  | "imports"
  | "decided_by"
  | "contradicts"
  | "supersedes"
  | "related_to"
  | "part_of"
  | "caused_by"
  | "resolved_by";

export type MemoryRelationshipType =
  | "similar"
  | "contradicts"
  | "supports"
  | "derives_from"
  | "summarizes"
  | "follows"
  | "references";

// ── Base Interface ────────────────────────────────────────────────────

export interface MemoryBase {
  id: string;                       // mem_<12-char-hex>
  scope: MemoryScope;
  projectId?: string;               // Working directory hash for project scope

  // Importance and decay
  importance: number;               // 0.0 - 1.0
  decayFactor: number;              // Multiplier applied over time
  accessCount: number;
  lastAccessed: number;             // Unix ms

  // Audit
  createdAt: number;                // Unix ms
  updatedAt: number;                // Unix ms
  version: number;
  source: SourceType;
  sourceId?: string;
}

// ── Memory Type Interfaces ────────────────────────────────────────────

export interface CoreMemory extends MemoryBase {
  type: "core";
  category: CoreCategory;
  key: string;                      // Unique within project
  title: string;
  content: string;
  summary?: string;
  confidence: number;               // 0.0 - 1.0
  evidenceCount: number;
  tags: string[];
}

export interface EpisodicMemory extends MemoryBase {
  type: "episodic";
  content: string;
  context: string;                  // What was happening when this occurred
  summary?: string;
  emotionalValence?: number;        // -1.0 to +1.0
  tags: string[];
  entities: string[];               // Entity IDs referenced
  occurredAt: number;               // When the event happened
}

export interface SemanticMemory extends MemoryBase {
  type: "semantic";
  category: SemanticCategory;
  key: string;                      // Unique identifier
  value: string;                    // The knowledge content
  confidence: number;               // 0.0 - 1.0
  evidenceCount: number;
  tags: string[];
  relatedKeys: string[];
  learnedAt: number;
  lastConfirmed: number;
}

export interface ProceduralStep {
  order: number;
  action: string;
  toolName?: string;
  expectedOutcome?: string;
}

export interface ProceduralMemory extends MemoryBase {
  type: "procedural";
  name: string;                     // "deploy-to-production"
  description: string;
  steps: ProceduralStep[];
  preconditions: string[];
  successRate: number;              // 0.0 - 1.0
  executionCount: number;
  tags: string[];
}

export interface WorkingMemory extends MemoryBase {
  type: "working";
  sessionId: string;
  key: string;
  value: string;
  priority: number;                 // Higher = more important
  ttlMs: number;
  expiresAt: number;                // Unix ms
}

/** Union of all memory types */
export type Memory = CoreMemory | EpisodicMemory | SemanticMemory | ProceduralMemory | WorkingMemory;

// ── Search Types ──────────────────────────────────────────────────────

export interface SearchOptions {
  query?: string;
  types?: MemoryType[];
  scope?: MemoryScope;
  tags?: string[];
  minImportance?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  matchType: "fts" | "vector" | "hybrid";
}

// ── Context Window Types ──────────────────────────────────────────────

export interface ContextWindowOptions {
  query?: string;
  maxTokens?: number;
  includeLayers?: MemoryType[];
  scope?: MemoryScope;
  minImportance?: number;
}

export interface ContextEntry {
  memoryId: string;
  type: MemoryType;
  content: string;
  relevanceScore: number;
  importance: number;
  source: string;
}

export interface ContextWindow {
  text: string;
  memories: ContextEntry[];
  stats: {
    totalMemories: number;
    byType: Record<MemoryType, number>;
    estimatedTokens: number;
    searchLatencyMs: number;
  };
}

// ── Knowledge Graph Types ─────────────────────────────────────────────

export interface Entity {
  id: string;                       // ent_<hex>
  type: EntityType;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Relationship {
  id: string;                       // rel_<hex>
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  strength: number;                 // 0.0 - 1.0
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ── V1 Compatibility ──────────────────────────────────────────────────

/** V1 memory entry format for migration */
export interface V1MemoryEntry {
  id: string;
  fact: string;
  layer: "session" | "project" | "global";
  tags: string[];
  createdAt: string;
  source?: string;
}

/** V1 recall result for backwards compatibility */
export interface V1RecallResult {
  entry: V1MemoryEntry;
  score: number;
}

// ── Helper: Generate IDs ──────────────────────────────────────────────

export function generateId(prefix: "mem" | "ent" | "rel" | "ver"): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

// ── Helper: Estimate Tokens ───────────────────────────────────────────

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Helper: Effective Importance ──────────────────────────────────────

/**
 * Calculate effective importance of a memory accounting for:
 * 1. Base importance
 * 2. Time decay (unused memories fade)
 * 3. Access boost (frequently used memories stay strong)
 * 4. Confidence (for semantic/core types)
 */
export function effectiveImportance(memory: MemoryBase & { confidence?: number }): number {
  const ageMs = Date.now() - memory.createdAt;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  // Time decay: half-life of 30 days
  const halfLife = 30;
  const timeDecay = Math.pow(0.5, ageDays / halfLife);

  // Access boost: each access extends effective half-life (max +50%)
  const accessBoost = Math.min(1.0, memory.accessCount * 0.05);

  // Recency of last access
  const lastAccessAge = memory.lastAccessed
    ? (Date.now() - memory.lastAccessed) / (24 * 60 * 60 * 1000)
    : ageDays;
  const accessRecency = Math.pow(0.5, lastAccessAge / (halfLife * 2));

  let effective = memory.importance * memory.decayFactor;
  effective *= timeDecay * (1 - accessBoost) + accessRecency * accessBoost;

  // Confidence boost for semantic/core types
  if (memory.confidence !== undefined && memory.confidence > 0) {
    effective *= 0.5 + 0.5 * memory.confidence;
  }

  return Math.max(0.01, Math.min(1.0, effective));
}
