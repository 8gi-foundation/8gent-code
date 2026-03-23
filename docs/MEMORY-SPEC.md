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

## What We're NOT Doing

- Not using Honcho as a dependency (import concepts, rebuild)
- Not building cloud sync yet (local SQLite only for v1)
- Not building a separate memory service (stays as a package)
- Not implementing Honcho's "dialectic" multi-model reasoning yet (v2)
