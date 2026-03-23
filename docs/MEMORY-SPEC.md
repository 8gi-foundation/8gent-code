# Memory Spec - Dual-Layer with Honcho Patterns

Detailed implementation spec for the 8gent memory layer. Incorporates patterns from FoodstackOS, Honcho (plastic-labs), and Supermemory research.

## Architecture

```
User message
  |
  v
Extractor (auto-extract facts from conversation)
  |
  v
MemoryManager
  |
  +---> remember(content, type)     --> SQLite store
  +---> learn(key, value, category) --> Semantic store with evidence
  +---> recall(query, options)      --> Hybrid FTS + vector search
  +---> ask(question, userId)       --> LLM reasons over memories (NEW)
  +---> forget(id) / unlearn(id)    --> Soft delete (confidence decay)
  |
  v
Consolidation Pipeline (background)
  |
  +---> Daily:   Summarize episodic -> semantic
  +---> Weekly:  Merge related semantic memories
  +---> Monthly: Generate peer representations (NEW)
  |
  v
Peer Representation (NEW)
  |
  +---> Natural language model of each user/agent
  +---> Updated after each consolidation run
  +---> Injected into system prompt for personalization
```

## Three Honcho Patterns to Incorporate

### 1. Session-Scoped Retrieval

**What it does:** Recalls memories relevant to the CURRENT conversation, not just globally relevant ones.

**Implementation:**

```typescript
// packages/memory/index.ts - add to recall()

interface RecallOptions {
  query: string;
  userId?: string;
  sessionContext?: string[];  // NEW: recent messages for context-aware retrieval
  limit?: number;
  types?: MemoryType[];
}

async recall(options: RecallOptions): Promise<Memory[]> {
  // 1. Standard hybrid search (existing)
  let results = await this.store.search(options.query, options);

  // 2. If sessionContext provided, re-rank by session relevance
  if (options.sessionContext?.length) {
    const sessionEmbedding = await this.embedder.embed(
      options.sessionContext.slice(-5).join(" ")
    );
    results = this.rerankBySessionRelevance(results, sessionEmbedding);
  }

  return results;
}
```

**Files:** `packages/memory/index.ts` (+30 lines), `packages/memory/recall.ts` (+20 lines)

### 2. ask() - Natural Language Memory Queries

**What it does:** Uses the LLM to answer questions about a user's memory. Not keyword search - it REASONS over the accumulated memories.

**Implementation:**

```typescript
// packages/memory/ask.ts - NEW FILE (~80 lines)

import { createModel } from "../ai/providers";

export async function askMemory(
  question: string,
  userId: string,
  store: MemoryStore,
  config: { model?: string; runtime?: string } = {}
): Promise<string> {
  // 1. Recall all memories for this user (with reasonable limit)
  const memories = await store.searchByUser(userId, { limit: 50 });

  if (memories.length === 0) {
    return "No memories found for this user.";
  }

  // 2. Format memories as context
  const memoryContext = memories
    .map((m, i) => `[${i + 1}] (${m.type}, importance: ${m.importance}) ${m.content}`)
    .join("\n");

  // 3. Use cheap model to reason over memories
  const model = createModel({
    name: (config.runtime as any) || "openrouter",
    model: config.model || "auto:free",
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const { text } = await generateText({
    model,
    prompt: `You are a memory analyst. Based on these memories about a user, answer the question.

MEMORIES:
${memoryContext}

QUESTION: ${question}

Answer based ONLY on the memories above. If the memories don't contain enough information, say so.`,
  });

  return text;
}
```

**Usage:**
```typescript
const answer = await mem.ask("What learning styles does this user respond to best?", userId);
const answer = await mem.ask("What mistakes has this agent made before?", agentId);
const answer = await mem.ask("What are James's top priorities right now?", "james");
```

**Files:** `packages/memory/ask.ts` (new, ~80 lines), `packages/memory/index.ts` (+10 lines to wire)

### 3. Peer Representations

**What it does:** After consolidation, generates a short natural language "representation" of each user/agent. A paragraph describing who they are based on accumulated memories. Gets injected into the system prompt.

**Implementation:**

```typescript
// packages/memory/representations.ts - NEW FILE (~70 lines)

export interface PeerRepresentation {
  userId: string;
  representation: string;  // Natural language paragraph
  updatedAt: string;
  memoryCount: number;
  topCategories: string[];
}

export async function generateRepresentation(
  userId: string,
  store: MemoryStore,
  model: LanguageModel
): Promise<PeerRepresentation> {
  const memories = await store.searchByUser(userId, { limit: 100 });

  // Group by category
  const categories: Record<string, string[]> = {};
  for (const m of memories) {
    const cat = m.category || m.type;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(m.content);
  }

  const topCategories = Object.entries(categories)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([k]) => k);

  // Generate representation
  const memorySnapshot = memories
    .slice(0, 50)
    .map((m) => `- ${m.content}`)
    .join("\n");

  const { text } = await generateText({
    model,
    prompt: `Based on these accumulated observations, write a 2-3 sentence description of this person/agent. Be specific about their preferences, patterns, and priorities. Do not speculate beyond what the data shows.

OBSERVATIONS:
${memorySnapshot}

DESCRIPTION:`,
  });

  return {
    userId,
    representation: text,
    updatedAt: new Date().toISOString(),
    memoryCount: memories.length,
    topCategories,
  };
}
```

**Where it gets injected:** The representation becomes part of `USER_CONTEXT_SEGMENT` in `packages/eight/prompts/system-prompt.ts`:

```typescript
// In system-prompt.ts, after user name/role injection:
if (peerRepresentation) {
  prompt += `\n\nWhat I know about this user:\n${peerRepresentation.representation}\n`;
}
```

**Files:** `packages/memory/representations.ts` (new, ~70 lines), `packages/eight/prompts/system-prompt.ts` (+10 lines)

## Updated File List

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/memory/consolidation.ts` | Create | ~200 | Daily/weekly/monthly pipeline with archetype detection |
| `packages/memory/tenant.ts` | Create | ~80 | userId + orgId enforcement, scoped indexes |
| `packages/memory/ask.ts` | Create | ~80 | LLM-powered natural language memory queries |
| `packages/memory/representations.ts` | Create | ~70 | Peer representation generator |
| `packages/memory/store.ts` | Modify | ~50 | New columns: consolidation_level, learning_type, evidence_count |
| `packages/memory/types.ts` | Modify | ~30 | New types for consolidation, learning, representations |
| `packages/memory/promote.ts` | Modify | ~40 | Soft-unlearn, evidence boost |
| `packages/memory/recall.ts` | Modify | ~20 | Session-scoped retrieval re-ranking |
| `packages/memory/index.ts` | Modify | ~40 | Wire ask(), representations, consolidation |
| `packages/eight/prompts/system-prompt.ts` | Modify | ~10 | Inject peer representation |

## Updated Estimates

| Component | Lines |
|-----------|-------|
| Consolidation pipeline | 200 |
| Tenant isolation | 80 |
| ask() method | 80 |
| Peer representations | 70 |
| Store schema changes | 50 |
| Type additions | 30 |
| Promotion/unlearn | 40 |
| Session-scoped recall | 20 |
| Wiring (index.ts + prompt) | 50 |
| **Total** | **620** |

## Clean API (Final)

```typescript
const mem = getMemoryManager(workingDirectory);

// Store
mem.remember("James prefers dark mode", "episodic", { userId: "james" })
mem.learn("theme", "dark", "preference", { userId: "james", confidence: 0.9 })

// Retrieve
mem.recall("what theme?", { userId: "james", sessionContext: recentMessages })
mem.ask("What does James care about most?", "james")  // LLM reasoning

// Manage
mem.unlearn(id, { soft: true })  // Confidence decay
mem.consolidate("daily")         // Background summarization

// Personalize
const rep = await mem.getRepresentation("james")
// -> "James is a full-stack engineer focused on building personal AI systems.
//     He prefers dark mode, direct communication, and values local-first
//     architecture. His top priorities are 8gent OS launch and Nick's Jr app."
```

## Dependencies

- `ai` package (already installed) - for generateText in ask() and representations
- SQLite (already used) - schema additions only
- No new external dependencies

## Artale Enhancements (from openclaw-memory review)

### 1. Temporal Decay with Relevance Scoring (+30 lines)

Auto-prune old memories. Two-tier: hard cutoff at 30 days, soft cutoff at 7 days for low-relevance items.

```typescript
// packages/memory/decay.ts - NEW FILE

function estimateRelevance(memory: Memory): number {
  let score = 0.5; // baseline
  // Category boost
  if (memory.source === 'curated' || memory.source === 'user_feedback') score += 0.3;
  // Personal fact detection
  if (/prefer|always|never|name is|lives in/i.test(memory.content)) score += 0.2;
  // Noise detection
  if (/good morning|thanks|ok|sure/i.test(memory.content)) score -= 0.3;
  // Length penalty (very short = likely noise)
  if (memory.content.length < 20) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

async function decay(userId: string, store: MemoryStore, config = { maxAgeDays: 30, lowRelevanceDays: 7 }) {
  const now = Date.now();
  const memories = await store.searchByUser(userId);
  for (const m of memories) {
    const ageDays = (now - new Date(m.createdAt).getTime()) / 86400000;
    if (ageDays > config.maxAgeDays) {
      await store.softDelete(m.id); // hard cutoff
    } else if (ageDays > config.lowRelevanceDays && estimateRelevance(m) < 0.3) {
      await store.softDelete(m.id); // soft cutoff for low-relevance
    }
  }
}
```

Add `decay()` to the API alongside `consolidate()`. Run on daemon heartbeat.

### 2. Feedback Loop Prevention (+20 lines)

Strip previously-injected memory context before extracting new facts. Without this, the system re-learns its own injections and memory grows unboundedly.

```typescript
// In the Extractor, before fact extraction:

function stripInjectedContext(message: string): string {
  // Remove blocks that were injected by the recall system
  return message
    .replace(/\[Memory Context\][\s\S]*?\[\/Memory Context\]/g, '')
    .replace(/What I know about this user:[\s\S]*?(?=\n\n)/g, '')
    .trim();
}
```

### 3. Auto-Injection via Hooks (+40 lines)

Instead of requiring the agent to call `recall()`, auto-inject relevant context into the system prompt before each turn. The agent does not need to remember to remember.

```typescript
// packages/memory/auto-inject.ts - NEW FILE

export async function buildMemoryContext(
  userId: string,
  recentMessages: string[],
  store: MemoryStore,
  config = { maxTokens: 2000, maxResults: 8, profileEveryNTurns: 50 }
): Promise<string> {
  // 1. Get user representation (cached, refreshed on consolidation)
  const rep = await getRepresentation(userId);

  // 2. Search for relevant memories based on recent conversation
  const query = recentMessages.slice(-3).join(' ');
  const memories = await store.search(query, {
    userId,
    limit: config.maxResults,
    maxTokens: config.maxTokens - estimateTokens(rep?.representation || '')
  });

  // 3. Deduplicate against representation (avoid repeating what the profile already says)
  const dedupedMemories = deduplicateAgainstProfile(memories, rep);

  // 4. Format as injectable context
  let context = '[Memory Context]\n';
  if (rep) context += `Profile: ${rep.representation}\n\n`;
  if (dedupedMemories.length > 0) {
    context += 'Relevant memories:\n';
    context += dedupedMemories.map(m => `- ${m.content}`).join('\n');
  }
  context += '\n[/Memory Context]';

  return context;
}
```

Wire into the daemon's prompt assembly so it runs before every agent turn.

### 4. "Total Memory" Consolidation Prompt (+5 lines)

The consolidation prompt must frame the output as the ENTIRE surviving memory, not a summary. This produces dramatically better results.

```typescript
// In consolidation.ts, the system prompt for the consolidation LLM call:

const CONSOLIDATION_PROMPT = `You are the memory curator for an AI agent.
Your output will become THE ENTIRETY of the agent's memory about this user.
Any information you do not include in your output will be IMMEDIATELY AND PERMANENTLY FORGOTTEN.
Be precise. Be selective. Preserve what matters. Discard noise.
Output structured observations, not prose.`;
```

### 5. Input Sanitization (+15 lines)

Strip invisible Unicode characters before fact extraction. Defends against prompt injection via Unicode Tags (invisible text that models can read but humans cannot).

```typescript
// packages/memory/sanitize.ts - NEW FILE

export function sanitize(input: string): string {
  return input
    // Unicode Tags (U+E0000-U+E007F) - invisible instructions
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    // Zero-width characters
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    // Bidirectional marks
    .replace(/[\u2066-\u2069\u202A-\u202E]/g, '')
    // Variation selectors
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '')
    .trim();
}
```

Run `sanitize()` on all user input before the Extractor processes it.

### 6. Porter Stemmer + Prefix Queries (+10 lines)

Use porter stemmer tokenization in FTS5 for better fuzzy matching.

```sql
-- Updated FTS5 table creation:
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags,
  tokenize='porter unicode61'
);
```

```typescript
// In recall, build queries with prefix expansion:
function buildFtsQuery(query: string): string {
  return query
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => `${w}*`)
    .join(' OR ');
}
```

### 7. Memory Usage Tracking (+25 lines)

Track which memories get retrieved AND contribute to successful outcomes. High-usage memories get priority during consolidation.

```typescript
// Add to Memory type:
interface Memory {
  // ... existing fields
  retrievalCount: number;    // how many times recalled
  lastRetrievedAt: string;   // when last recalled
  contributedToSuccess: number; // times this memory was in context when task succeeded
}

// After each successful agent action, boost memories that were in context:
async function trackSuccess(memoriesInContext: string[], store: MemoryStore) {
  for (const id of memoriesInContext) {
    await store.incrementSuccess(id);
  }
}
```

During consolidation, memories with high `contributedToSuccess` get priority over recency.

## Updated File List (Final)

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/memory/consolidation.ts` | Create | ~200 | Pipeline with "total memory" prompt framing |
| `packages/memory/tenant.ts` | Create | ~80 | userId + orgId enforcement |
| `packages/memory/ask.ts` | Create | ~80 | LLM-powered natural language queries |
| `packages/memory/representations.ts` | Create | ~70 | Peer representation generator |
| `packages/memory/decay.ts` | Create | ~30 | Temporal decay with relevance scoring |
| `packages/memory/auto-inject.ts` | Create | ~40 | Auto-inject context before each turn |
| `packages/memory/sanitize.ts` | Create | ~15 | Unicode smuggling defense |
| `packages/memory/store.ts` | Modify | ~60 | Schema + porter stemmer + usage tracking |
| `packages/memory/types.ts` | Modify | ~40 | New types + retrievalCount + contributedToSuccess |
| `packages/memory/promote.ts` | Modify | ~40 | Soft-unlearn, evidence boost |
| `packages/memory/recall.ts` | Modify | ~30 | Session-scoped + prefix queries + feedback loop strip |
| `packages/memory/index.ts` | Modify | ~50 | Wire all new methods |
| `packages/eight/prompts/system-prompt.ts` | Modify | ~15 | Inject auto-context + representation |
| `packages/memory/__tests__/isolation.test.ts` | Create | ~80 | User isolation tests |
| `packages/memory/__tests__/decay.test.ts` | Create | ~60 | Decay + relevance tests |
| **Total** | | **~890** | |

## Inspired By

- **FoodstackOS** memory manager (episodic + semantic, hybrid search, consolidation)
- **Honcho** by Plastic Labs (peer representations, natural language queries, token budgeting)
- **Artale's openclaw-memory** (temporal decay, feedback loop prevention, auto-injection, sanitization, porter stemmer, "total memory" prompt framing, usage tracking)
- **Supermemory** (99% SOTA, evaluate when open sourced)

## What We're NOT Doing

- Not using Honcho as a dependency (import concepts, rebuild)
- Not using Artale's mock SQLite (we have real SQLite)
- Not using ALMA evolutionary optimizer (speculative complexity)
- Not using XML-in-markdown (SQLite for structured, markdown for human-readable)
- Not using emotional resonance tracking (no measurable outcome)
- Not building cloud sync yet (local SQLite only for v1)
- Not building a separate memory service (stays as a package)
- Not implementing Honcho's "dialectic" multi-model reasoning yet (v2)
