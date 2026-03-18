# Project Brief: Eight Memory System v2 — Multi-Layered Knowledge Intelligence

**Date:** 2026-03-18
**Author:** BMAD Analyst + Architect
**Package:** `packages/memory/`
**Status:** Proposed

---

## 1. Problem Statement

The current 8gent memory system (`packages/memory/index.ts`, ~450 lines) is a minimal v1 prototype with fundamental limitations that prevent 8gent from becoming a true AI OS kernel:

### Current Architecture (v1)

| Aspect | Current State | Impact |
|--------|--------------|--------|
| **Storage** | JSONL append-only files (session/project/global) | No concurrent writes, no ACID, corruption risk |
| **Search** | Keyword tokenization + substring matching | Misses semantic similarity, paraphrasing, synonyms |
| **Memory types** | Flat `MemoryEntry` with `fact` string | No distinction between events, knowledge, procedures, entities |
| **Extraction** | Hardcoded `extractAutoMemories()` for package.json, tsconfig, Dockerfiles | Brittle string matching; violates the AI Judging Rule in CLAUDE.md |
| **Tagging** | Regex-based `extractTags()` with hardcoded keyword lists | Not adaptive; misses project-specific terminology |
| **Versioning** | None | Cannot rollback bad memories; no audit trail |
| **Consolidation** | None | Unbounded growth; no summarization or decay |
| **Embeddings** | None (comment says "upgradeable to embeddings later") | Cannot do semantic search |
| **Knowledge graph** | None | No entity-relationship tracking |
| **Multi-agent** | None | No memory sharing between concurrent agents |
| **Cloud sync** | None (Convex DB has sessions/usage but not memories) | Memories lost when switching machines |
| **Context injection** | Linear reverse-chronological dump into prompt | No relevance-weighted assembly |

### Why This Matters

Without intelligent memory, every 8gent session starts nearly from scratch. The agent repeatedly asks the same questions, cannot learn from past mistakes, cannot build a knowledge graph of the codebase, and cannot transfer learnings between projects. This is the single largest gap between 8gent and a production-grade AI OS kernel.

---

## 2. Vision

Memory v2 transforms 8gent from a stateless coding tool into a continuously learning AI collaborator. The system should:

1. **Remember like a human** — distinguish between events (episodic), facts (semantic), skills (procedural), and active context (working)
2. **Search like a search engine** — hybrid text + vector search with relevance scoring
3. **Learn like a scientist** — extract patterns, update confidence, consolidate over time
4. **Forget like a brain** — decay unused memories, consolidate related ones, prune contradictions
5. **Share like a team** — memories scoped to session, project, user, and optionally shared across agents
6. **Understand relationships** — build a knowledge graph of entities (files, functions, packages, people, decisions) and their connections
7. **Feed the kernel** — training data from memory powers the GRPO fine-tuning pipeline

### North Star Metric

> An 8gent instance that has worked on a project for 20 sessions should produce measurably better first-turn responses than a fresh instance, as judged by an LLM evaluator (not string matching).

---

## 3. Lessons from FoodstackOS

James has already built a mature memory system in FoodstackOS (`lib/memory/`, `convex/memoryEnhanced.ts`, `convex/knowledgeBase.ts`, `convex/tenantMemory.ts`). This is the primary reference architecture. Key takeaways:

### What to Reuse / Adapt

| FoodstackOS Feature | 8gent Adaptation |
|---------------------|-----------------|
| **5-layer taxonomy** (Platform KB, Tenant Core, Episodic, Semantic, Working) | Map to 4 layers: Core (project knowledge), Episodic (session events), Semantic (learned facts), Working (active context) — no "tenant" needed for a CLI tool |
| **Type system** (`lib/memory/types.ts` — 585 lines of precise interfaces) | Port directly; types are framework-agnostic |
| **Consolidation pipeline** (raw -> daily -> weekly -> monthly -> archetype) | Reuse the level hierarchy; replace OpenAI consolidation LLM with local Ollama call |
| **Importance scoring** (0.0-1.0 with emotional valence) | Reuse scoring model; add "source reliability" dimension for auto-extracted vs user-stated |
| **Decay factor** with access count tracking | Port directly — `decayFactor`, `accessCount`, `lastAccessed` |
| **Hybrid search** (Convex text index + 1536-dim vector embeddings) | Adapt to SQLite FTS5 + local embeddings (Ollama `nomic-embed-text`, 768-dim) |
| **Memory relationships** (`similar`, `contradicts`, `supports`, `derives_from`, `summarizes`, `follows`, `references`) | Port directly; this IS the knowledge graph edge vocabulary |
| **Context window assembly** (`getFullContext()` with attribution) | Reuse architecture; add token-budget-aware prioritization |
| **Entity extraction** (entities table with types, relationships, annotations) | Simplify for code: files, functions, packages, configs, decisions, people |
| **Consolidation jobs** (pending/running/completed/failed state machine) | Reuse for background processing |
| **LLM-powered consolidation** (`consolidation.ts` — uses `generateText` with structured prompts) | Replace OpenAI with local model or OpenRouter judge |
| **Memory metrics & observability** (`MemoryMetrics`, `MemoryHealthStatus`) | Port for TUI dashboard |
| **Learning events** (tracking what was learned from agent actions) | Direct parallel with GRPO training samples |

### What NOT to Reuse

| FoodstackOS Feature | Why Skip |
|---------------------|----------|
| **Multi-tenant isolation** (organizationId boundaries) | 8gent is single-user; project-level scoping is sufficient |
| **OpenAI embeddings** (text-embedding-3-small, 1536-dim, $0.02/1M tokens) | 8gent is local-first; use Ollama nomic-embed-text (768-dim, free, offline) |
| **Convex as primary store** | 8gent needs local SQLite for offline operation; Convex is optional sync target |
| **Tenant core memory** (organization SOPs) | No multi-tenant; but the concept maps to "project knowledge base" |
| **Platform KB** (curated FoodStack knowledge) | No centralized platform; replaced by user's own global knowledge |

### Key Architectural Insight

FoodstackOS proves that the `MemoryManager` class pattern works well as a facade over multiple storage backends. The `getFullContext()` method that assembles context from all layers with attribution and token budgeting is the most important pattern to replicate. The consolidation pipeline (daily -> weekly -> monthly -> archetype) with LLM-generated summaries is the second most important — it solves unbounded growth.

---

## 4. MoSCoW Feature Prioritization

### Must Have (v2.0)

- [ ] **SQLite storage backend** — replace JSONL with WAL-mode SQLite (via `better-sqlite3` / `bun:sqlite`)
- [ ] **Memory type taxonomy** — separate tables/types for Episodic, Semantic, Working, and Core (project KB)
- [ ] **Local embedding generation** — Ollama `nomic-embed-text` (768-dim) for all stored memories
- [ ] **Hybrid search** — FTS5 full-text + cosine similarity vector search with weighted fusion
- [ ] **Importance scoring** — 0.0-1.0 with source type weighting and recency boost
- [ ] **Decay and access tracking** — `decayFactor`, `accessCount`, `lastAccessed` per memory
- [ ] **Context window assembly** — token-budget-aware `getFullContext()` with layer prioritization and attribution
- [ ] **LLM-based extraction** — replace hardcoded `extractAutoMemories()` with judge-model extraction (per AI Judging Rule)
- [ ] **Migration from v1** — import existing `.8gent/memory/project.jsonl` and `~/.8gent/memory/global.jsonl`
- [ ] **Forget/update operations** — edit, delete, and correct memories with audit trail
- [ ] **Memory tools v2** — upgraded `remember` and `recall` tools that expose memory types

### Should Have (v2.1)

- [ ] **Knowledge graph** — entities and relationships extracted from conversations and code
- [ ] **Entity types** — file, function, package, config, decision, person, concept
- [ ] **Relationship edges** — depends_on, defines, imports, decided_by, contradicts, supersedes
- [ ] **Consolidation pipeline** — daily -> weekly -> monthly summarization with LLM
- [ ] **Memory versioning** — full history of changes with rollback capability
- [ ] **Confidence tracking** — evidenceCount, lastConfirmed, automatic confidence decay
- [ ] **Convex cloud sync** — optional sync of memory to Convex for cross-machine persistence
- [ ] **TUI memory dashboard** — `/memory` screen showing stats, search, and management
- [ ] **Memory health metrics** — density, growth rate, staleness indicators

### Could Have (v2.2)

- [ ] **Procedural memory** — learned workflows, command sequences, and multi-step patterns
- [ ] **Cross-project learning** — transfer applicable patterns between projects
- [ ] **Memory federation** — share memory subsets between 8gent instances (multi-agent)
- [ ] **CLUI memory view** — Tauri desktop app memory browser with graph visualization
- [ ] **Kernel training integration** — feed high-confidence memories as GRPO training context
- [ ] **`@` context mentions** — `@memory`, `@knowledge:auth`, `@recent` syntax in prompts
- [ ] **Smart forgetting** — LLM-judged memory pruning for contradicted or outdated facts
- [ ] **Memory export/import** — JSON/SQLite dump for backup and migration

### Won't Have (this version)

- Multi-tenant isolation (8gent is single-user)
- Platform knowledge base (no centralized knowledge curation)
- Real-time collaborative memory editing
- Memory marketplace / sharing between users
- GPU-accelerated embedding generation

---

## 5. Success Metrics

### Quantitative

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Recall accuracy** | >80% precision@10 on semantic queries | Benchmark suite with known facts and queries |
| **Context relevance** | >70% of injected context rated "useful" by LLM judge | Sample 100 context windows, judge each entry |
| **Memory extraction rate** | >5 memories per session automatically | Count auto-extracted memories per session |
| **Search latency** | <50ms for hybrid search on 10K memories | Benchmark local SQLite + embedding search |
| **Migration completeness** | 100% of v1 JSONL entries imported | Count v1 entries vs v2 entries post-migration |
| **Storage efficiency** | <100MB for 50K memories including embeddings | Measure SQLite file size |

### Qualitative

| Metric | Validation |
|--------|-----------|
| **First-turn quality** | Sessions 10+ on a project produce measurably better first responses than session 1 (LLM-judged A/B test) |
| **Knowledge persistence** | Agent remembers project conventions, past decisions, and user preferences across sessions |
| **Contradiction handling** | When new information contradicts stored memory, the system flags and resolves it |
| **Graceful degradation** | If Ollama is unavailable (no embeddings), falls back to FTS5-only search without error |

### Operational

| Metric | Target |
|--------|--------|
| **Zero data loss** on migration from v1 | Verified by count comparison |
| **Backward compatible** tool interface | `remember` and `recall` tools work identically for users |
| **No external API required** for core operation | All memory ops work offline with Ollama |
| **Startup overhead** | <100ms to initialize MemoryManager v2 |

---

## 6. Dependencies and Risks

### Dependencies

| Dependency | Purpose | Risk |
|-----------|---------|------|
| `bun:sqlite` or `better-sqlite3` | Local storage | Low — Bun has native SQLite support |
| Ollama `nomic-embed-text` | Local embeddings | Medium — requires user to have model pulled |
| Vercel AI SDK (`ai` package) | LLM judge for extraction and consolidation | Low — already a core dependency |
| OpenRouter (optional) | Cloud model for consolidation if local unavailable | Low — graceful fallback |

### Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Embedding model not available locally | Medium | High — falls back to keyword-only | Auto-pull `nomic-embed-text` on first use; FTS5 fallback |
| SQLite file locking with concurrent agents | Medium | Medium — write conflicts | WAL mode + retry with backoff |
| Memory bloat from aggressive auto-extraction | High | Low — annoying but not breaking | Importance threshold; consolidation pipeline |
| Migration corrupts v1 data | Low | High — data loss | Read-only migration; keep v1 files as backup |
| Embedding dimension mismatch across model updates | Low | High — search breaks | Store `embeddingModel` with each memory; re-embed on model change |

---

## 7. Stakeholders

| Role | Interest |
|------|---------|
| **8gent users** | Better context persistence across sessions; smarter agent |
| **Kernel training pipeline** | High-quality memory as training signal for GRPO |
| **TUI/CLUI interfaces** | Memory dashboard, search, and management UI |
| **Multi-agent orchestration** | Shared memory between concurrent agent instances |
| **8gent-as-product** | Key differentiator vs competitors (Cursor, Aider, Claude Code) |
