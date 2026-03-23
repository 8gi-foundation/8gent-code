# Harness Abilities Plan

Concrete implementation plan for inheriting 8 abilities into the 8gent-code vessel harness.

---

## 1. Memory - Dual-Layer with Decay & Consolidation

### What Exists Today

`packages/memory/` - 4,075 lines across 10 files:
- `index.ts` (1140 lines) - MemoryManager v2 facade
- `store.ts` (811 lines) - SQLite + FTS5 + optional vector
- `graph.ts` (547 lines) - Knowledge graph (entities, relationships)
- `extractor.ts` (463 lines) - Auto-extraction from tool results
- `promote.ts` (148 lines) - Frequency-based promotion (3+ recalls = core)
- `types.ts` (317 lines) - 5-layer taxonomy (core, episodic, semantic, procedural, working)
- `embeddings.ts` (201 lines) - Ollama + null providers
- `recall.ts` (119 lines) - Hybrid FTS + vector search

### What FoodstackOS Has That We Don't

Source: `~/Foodstackai/fsai-001-donna/src/memory/` (16,984 lines) + `convex/memoryEnhanced.ts` (13,723 lines)

| Gap | FoodstackOS Pattern | 8gent-code Status |
|-----|---------------------|-------------------|
| Consolidation pipeline | raw -> daily -> weekly -> monthly -> archetype | Missing entirely |
| Tenant isolation | organizationId + userId on every mutation, enforced in DB indexes | Optional userId field, not enforced |
| Soft unlearn | Confidence halving instead of hard delete | Hard archive at 30 days |
| Evidence tracking | evidenceCount incremented on repeated confirmation | Not tracked |
| Learning types | preference, behavior, outcome, correction, feedback | Flat "semantic" bucket |
| Multi-provider embeddings | OpenAI, Gemini, Voyage, Mistral batch support | Ollama only |

### Files to Create/Modify

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/memory/consolidation.ts` | Create | ~200 | Daily/weekly summary aggregation, archetype detection |
| `packages/memory/tenant.ts` | Create | ~80 | userId + orgId enforcement layer, scoped indexes |
| `packages/memory/store.ts` | Modify | ~50 | Add consolidation_level, learning_type, evidence_count columns |
| `packages/memory/types.ts` | Modify | ~30 | Add ConsolidationLevel, LearningType, EvidenceTracking types |
| `packages/memory/promote.ts` | Modify | ~40 | Add soft-unlearn (confidence decay), evidence boost |
| `packages/memory/index.ts` | Modify | ~30 | Wire consolidation into manager, add learn/unlearn API |

**Total new code:** ~430 lines
**Dependencies:** None (pure SQLite, no new packages)

### Clean API Design

```typescript
// Remember (episodic)
mem.remember("James prefers dark mode", "episodic", { userId, importance: 0.8 })

// Learn (semantic - with evidence tracking)
mem.learn("user-theme", "dark", "preference", { userId, confidence: 0.9 })

// Recall (hybrid search)
mem.recall("what theme does James use", { userId, limit: 5 })

// Unlearn (soft - confidence halving, not delete)
mem.unlearn(memoryId, { soft: true })

// Consolidate (background job)
mem.consolidate("daily") // Summarize today's episodic into semantic
```

---

## 2. Browser-Use - CLI Integration

### What Exists Today

`packages/tools/browser/` - Lightweight fetch + DuckDuckGo HTML scraping:
- `fetch-page.ts` - HTTP fetch + Readability.js extraction
- `web-search.ts` - DuckDuckGo HTML scraper
- `html-to-text.ts` - Regex HTML stripper
- `cache.ts` - SHA256 disk cache

### What browser-use CLI Offers

CLI installed at `~/.pyenv/shims/browser-use`. Supports:
- Real Chrome with profiles (authenticated browsing)
- Remote cloud browsers (no local Chrome needed)
- Persistent sessions across commands
- JavaScript evaluation
- Cookie management
- Screenshot + state inspection
- Task execution with LLM reasoning

### Files to Create/Modify

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/tools/browser-use.ts` | Create | ~180 | Wrapper for browser-use CLI commands |
| `packages/eight/tools.ts` | Modify | ~40 | Add 4 new tools: browser_open, browser_state, browser_task, browser_screenshot |

**Total new code:** ~220 lines
**Dependencies:** browser-use CLI must be installed (`pip install browser-use`)

### New Tools

```typescript
// Open URL and get state
browser_open({ url: "https://github.com/PodJamz" })

// Get current page elements with indices
browser_state()

// Run complex browser task with LLM reasoning
browser_task({ task: "Log into GitHub and check PR notifications" })

// Take screenshot and return path
browser_screenshot({ path: "/tmp/screenshot.png" })
```

### Vessel Integration

The browser-use CLI needs to be added to the Vessel Dockerfile:
```dockerfile
RUN pip install browser-use
```

For the vessel container, use `--browser remote` mode (cloud browser, no local Chrome needed).

---

## 3. Soul Layers - Access-Based Prompt Composition

### What Exists Today

- `packages/self-autonomy/persona-mutation.ts` - Reads SOUL.md calibration, applies feedback
- `packages/self-autonomy/onboarding.ts` - Communication style selection (concise/detailed/casual/formal)
- `packages/eight/prompts/system-prompt.ts` - Single system prompt with USER_CONTEXT_SEGMENT injection
- `SOUL.md` - Agent persona definition with 6 calibration parameters

### What AI James OS Has

Source: `~/Myresumeportfolio/src/lib/ai-james/soul-layers.ts` (~200 lines)

Three-tier access model:
- **Visitor:** Public-facing, polished, limited disclosure
- **Collaborator:** Working relationship, shared context, technical depth
- **Owner:** Full access, raw thoughts, unfiltered

Each tier composes different prompt segments. The system prompt is assembled from layers, not written as one block.

### Files to Create/Modify

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/eight/prompts/soul-layers.ts` | Create | ~150 | Access tier definitions, prompt segment composer |
| `packages/eight/prompts/system-prompt.ts` | Modify | ~30 | Replace monolithic prompt with layered composition |
| `packages/daemon/telegram-bridge.ts` | Modify | ~10 | Pass access tier from user authentication |

**Total new code:** ~190 lines
**Dependencies:** Must build after Memory (layer 1) since soul context references memory

### Design

```typescript
type AccessTier = "visitor" | "collaborator" | "owner";

function composeSoulPrompt(tier: AccessTier, userContext: UserContext): string {
  const layers = [
    CORE_IDENTITY,           // Always: name, role, principles
    CAPABILITY_LAYER,        // Always: what Eight can do
    tier === "owner" ? OWNER_LAYER : null,        // Full context, raw access
    tier === "collaborator" ? COLLAB_LAYER : null, // Working context, technical depth
    tier === "visitor" ? VISITOR_LAYER : null,     // Public face, limited
    USER_CONTEXT_SEGMENT(userContext),              // Personalization
  ];
  return layers.filter(Boolean).join("\n\n");
}
```

---

## 4. Tool Design - "Seeing Like an Agent"

### What Exists Today

`packages/eight/tools.ts` - 24 tools in a flat list:
- 4 AST tools (get_outline, get_symbol, search_symbols, get_project_outline)
- 4 file tools (read, write, edit, list)
- 5 git tools (status, diff, log, add, commit)
- 4 orchestration tools (run_command, spawn_agent, check_agent, list_agents)
- 2 web tools (search, fetch)
- 2 design tools (suggest, query)
- 3 memory/autonomy tools (infinite_mode, remember, recall)

### Audit Findings

From the "Seeing Like an Agent" article (Anthropic engineer):

**Problem:** Tools designed for human understanding, not model understanding.

| Issue | Current State | Fix |
|-------|--------------|-----|
| Tool descriptions are human-oriented | "Read file contents" | Describe what the model GETS: "Returns file text. Use when you need to see code before editing." |
| Too many similar tools | read_file vs get_outline vs get_symbol | Consolidate with clear routing hints |
| No tool chaining hints | Model guesses sequence | Add "typically used after X" in descriptions |
| Flat namespace | 24 tools, no grouping | Group by domain in description prefix |
| Missing error guidance | Tools return raw errors | Add "if this fails, try X instead" |

### Files to Modify

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `packages/eight/tools.ts` | Modify | ~100 | Rewrite all 24 tool descriptions for model consumption |
| `packages/eight/prompts/system-prompt.ts` | Modify | ~20 | Add tool usage patterns section |

**Total changes:** ~120 lines modified (no new files)
**Dependencies:** None - can be done independently

### Example Rewrites

```typescript
// Before:
description: "Read file contents"

// After:
description: "Returns the text content of a file at the given path. Use this when you need to see existing code before modifying it. If the file is large (>500 lines), consider get_outline first to find the specific function you need, then use get_symbol to read just that function."
```

---

## Implementation Order & Dependencies

```
Week 1: Memory (foundation)
  └── Consolidation, tenant isolation, clean API
  └── No dependencies

Week 2: Browser-Use + Tool Design (parallel)
  ├── Browser-Use: CLI wrapper, 4 new tools
  │   └── No dependencies
  └── Tool Design: Rewrite descriptions
      └── No dependencies

Week 3: Soul Layers
  └── Depends on Memory (references memory for context)
  └── Depends on Tool Design (prompt composition needs clean tool docs)
```

## Estimated Total

| Ability | New Lines | Modified Lines | New Files | Modified Files |
|---------|-----------|----------------|-----------|----------------|
| Memory | 280 | 150 | 2 | 4 |
| Browser-Use | 180 | 40 | 1 | 1 |
| Soul Layers | 150 | 40 | 1 | 2 |
| Tool Design | 0 | 120 | 0 | 2 |
| **Total** | **610** | **350** | **4** | **9** |

~960 lines of changes across 13 files. Manageable scope for 3 weeks of focused work.
